use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use jsonwebtoken::jwk::JwkSet;
use jsonwebtoken::{decode, decode_header, DecodingKey, Validation};
use serde::Deserialize;
use tokio::sync::RwLock;

const JWKS_CACHE_TTL: Duration = Duration::from_secs(900);
const ROOM_ACCESS_CACHE_TTL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
pub struct AuthenticatedUser {
    pub user_id: String,
}

#[derive(Debug, Clone)]
pub struct LiveKitConfig {
    pub url: String,
    pub api_key: String,
    pub api_secret: String,
}

#[derive(Debug, Clone)]
pub struct SupabaseAuth {
    supabase_url: String,
    publishable_key: String,
    secret_key: String,
    http: reqwest::Client,
    jwks_cache: Arc<RwLock<Option<CachedJwks>>>,
    room_access_cache: Arc<RwLock<HashMap<(String, String), Instant>>>,
}

#[derive(Debug, Deserialize)]
struct ServerMemberRoleRow {
    role: String,
}

#[derive(Debug, Deserialize)]
struct VoiceChannelRow {
    #[allow(dead_code)]
    id: String,
    #[serde(default)]
    server_id: String,
}

#[derive(Debug, Deserialize)]
struct DirectChannelIdRow {
    #[allow(dead_code)]
    id: String,
}

#[derive(Debug, Clone)]
struct CachedJwks {
    jwks: JwkSet,
    fetched_at: Instant,
}

#[derive(Debug, Deserialize)]
struct SupabaseClaims {
    sub: String,
}

#[derive(Debug, Deserialize)]
struct SupabaseUserResponse {
    id: String,
}

impl SupabaseAuth {
    pub fn from_env() -> Self {
        let supabase_url = std::env::var("SUPABASE_URL")
            .unwrap_or_default()
            .trim_end_matches('/')
            .to_string();
        let publishable_key = std::env::var("SUPABASE_PUBLISHABLE_KEY").unwrap_or_default();
        let secret_key = std::env::var("SUPABASE_SECRET_KEY")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .or_else(|| {
                std::env::var("SUPABASE_SERVICE_ROLE_KEY")
                    .ok()
                    .filter(|v| !v.trim().is_empty())
            })
            .unwrap_or_default();

        Self::with_secret(supabase_url, publishable_key, secret_key)
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn new(supabase_url: String, publishable_key: String) -> Self {
        Self::with_secret(supabase_url, publishable_key, String::new())
    }

    pub fn with_secret(supabase_url: String, publishable_key: String, secret_key: String) -> Self {
        Self {
            supabase_url: supabase_url.trim_end_matches('/').to_string(),
            publishable_key,
            secret_key,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(8))
                .build()
                .expect("failed to build reqwest client"),
            jwks_cache: Arc::new(RwLock::new(None)),
            room_access_cache: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn is_configured(&self) -> bool {
        !self.supabase_url.is_empty()
    }

    /// Verifies that `user_id` is authorized to join `room_id` (either a server voice
    /// channel where the user is a member, or a `dm:<uuid>` direct call where the user
    /// is one of the two participants).
    pub async fn verify_voice_room_access(
        &self,
        room_id: &str,
        user_id: &str,
        actor_bearer_token: Option<&str>,
    ) -> Result<(), String> {
        if self.supabase_url.is_empty() {
            return Ok(());
        }

        if !is_safe_id(user_id) {
            return Err("invalid authenticated user identifier".to_string());
        }

        let cache_key = (user_id.to_string(), room_id.to_string());
        {
            let guard = self.room_access_cache.read().await;
            if let Some(verified_at) = guard.get(&cache_key) {
                if verified_at.elapsed() < ROOM_ACCESS_CACHE_TTL {
                    return Ok(());
                }
            }
        }

        let (apikey, bearer) = if !self.secret_key.is_empty() {
            (self.secret_key.as_str(), self.secret_key.as_str())
        } else if let Some(tok) = actor_bearer_token.filter(|s| !s.trim().is_empty()) {
            (self.publishable_key.as_str(), tok)
        } else {
            return Err("missing Supabase credentials for room permission check".to_string());
        };

        if apikey.is_empty() {
            return Err("missing Supabase API key for room permission check".to_string());
        }

        if let Some(dm_id) = room_id.strip_prefix("dm:") {
            if !is_safe_id(dm_id) {
                return Err("invalid direct call room identifier".to_string());
            }

            let dm_url = format!(
                "{}/rest/v1/direct_channels?id=eq.{dm_id}&or=(user_a.eq.{user_id},user_b.eq.{user_id})&select=id",
                self.supabase_url
            );
            let dm_res = self
                .http
                .get(&dm_url)
                .header("apikey", apikey)
                .bearer_auth(bearer)
                .send()
                .await
                .map_err(|e| format!("failed to verify direct call access: {e}"))?;

            if !dm_res.status().is_success() {
                return Err(format!(
                    "Supabase direct channel check returned HTTP {}",
                    dm_res.status()
                ));
            }

            let rows: Vec<DirectChannelIdRow> = dm_res
                .json()
                .await
                .map_err(|e| format!("invalid direct_channels payload: {e}"))?;

            if rows.is_empty() {
                return Err("you are not a participant of this direct call".to_string());
            }
        } else {
            if !is_safe_id(room_id) {
                return Err("invalid voice channel identifier".to_string());
            }

            let channel_url = format!(
                "{}/rest/v1/channels?id=eq.{room_id}&type=eq.voice&select=id,server_id",
                self.supabase_url
            );
            let channel_res = self
                .http
                .get(&channel_url)
                .header("apikey", apikey)
                .bearer_auth(bearer)
                .send()
                .await
                .map_err(|e| format!("failed to verify voice channel: {e}"))?;

            if !channel_res.status().is_success() {
                return Err(format!(
                    "Supabase channel check returned HTTP {}",
                    channel_res.status()
                ));
            }

            let channel_rows: Vec<VoiceChannelRow> = channel_res
                .json()
                .await
                .map_err(|e| format!("invalid channels payload: {e}"))?;

            let Some(ch) = channel_rows.first() else {
                return Err("voice channel not found or access denied".to_string());
            };

            if !is_safe_id(&ch.server_id) {
                return Err("voice channel has invalid server_id".to_string());
            }

            let member_url = format!(
                "{}/rest/v1/server_members?server_id=eq.{}&user_id=eq.{user_id}&select=role",
                self.supabase_url, ch.server_id
            );
            let member_res = self
                .http
                .get(&member_url)
                .header("apikey", apikey)
                .bearer_auth(bearer)
                .send()
                .await
                .map_err(|e| format!("failed to verify server membership: {e}"))?;

            if !member_res.status().is_success() {
                return Err(format!(
                    "Supabase membership check returned HTTP {}",
                    member_res.status()
                ));
            }

            let member_rows: Vec<ServerMemberRoleRow> = member_res
                .json()
                .await
                .map_err(|e| format!("invalid server_members payload: {e}"))?;

            if member_rows.is_empty() {
                return Err("you are not a member of this server".to_string());
            }
        }

        let mut guard = self.room_access_cache.write().await;
        if guard.len() > 1024 {
            guard.retain(|_, ts| ts.elapsed() < ROOM_ACCESS_CACHE_TTL);
        }
        guard.insert(cache_key, Instant::now());
        Ok(())
    }

    /// Verifies that `actor_user_id` is an `owner` or `admin` of `server_id` and that
    /// `target_room_id` is a valid voice channel belonging to `server_id`.
    pub async fn verify_server_admin_and_voice_channel(
        &self,
        server_id: &str,
        target_room_id: &str,
        actor_user_id: &str,
        actor_bearer_token: Option<&str>,
    ) -> Result<(), String> {
        if self.supabase_url.is_empty() {
            return Err("SUPABASE_URL is not configured on server".to_string());
        }

        if !is_safe_id(server_id) || !is_safe_id(target_room_id) || !is_safe_id(actor_user_id) {
            return Err("invalid identifier in MovePeerToRoom".to_string());
        }

        let (apikey, bearer) = if !self.secret_key.is_empty() {
            (self.secret_key.as_str(), self.secret_key.as_str())
        } else if let Some(tok) = actor_bearer_token.filter(|s| !s.trim().is_empty()) {
            (self.publishable_key.as_str(), tok)
        } else {
            return Err("missing Supabase credentials for server permission check".to_string());
        };

        if apikey.is_empty() {
            return Err("missing Supabase API key for permission check".to_string());
        }

        let member_url = format!(
            "{}/rest/v1/server_members?server_id=eq.{server_id}&user_id=eq.{actor_user_id}&select=role",
            self.supabase_url
        );
        let member_res = self
            .http
            .get(&member_url)
            .header("apikey", apikey)
            .bearer_auth(bearer)
            .send()
            .await
            .map_err(|e| format!("failed to verify server role: {e}"))?;

        if !member_res.status().is_success() {
            return Err(format!(
                "Supabase role verification returned HTTP {}",
                member_res.status()
            ));
        }

        let rows: Vec<ServerMemberRoleRow> = member_res
            .json()
            .await
            .map_err(|e| format!("invalid server_members payload: {e}"))?;

        let is_admin = rows
            .first()
            .is_some_and(|r| r.role == "owner" || r.role == "admin");
        if !is_admin {
            return Err("only server owners or admins can move peers".to_string());
        }

        let channel_url = format!(
            "{}/rest/v1/channels?id=eq.{target_room_id}&server_id=eq.{server_id}&type=eq.voice&select=id",
            self.supabase_url
        );
        let channel_res = self
            .http
            .get(&channel_url)
            .header("apikey", apikey)
            .bearer_auth(bearer)
            .send()
            .await
            .map_err(|e| format!("failed to verify target voice channel: {e}"))?;

        if !channel_res.status().is_success() {
            return Err(format!(
                "Supabase channel verification returned HTTP {}",
                channel_res.status()
            ));
        }

        let channel_rows: Vec<VoiceChannelRow> = channel_res
            .json()
            .await
            .map_err(|e| format!("invalid channels payload: {e}"))?;

        if channel_rows.is_empty() {
            return Err("target_room_id is not a voice channel in this server".to_string());
        }

        Ok(())
    }

    /// Validates a Supabase Auth JWT using cached JWKS public keys first,
    /// falling back to `GET {SUPABASE_URL}/auth/v1/user` with `SUPABASE_PUBLISHABLE_KEY`.
    pub async fn verify_bearer_token(&self, token: &str) -> Result<AuthenticatedUser, String> {
        let token = token.trim();
        if token.is_empty() {
            return Err("empty bearer token".to_string());
        }
        if self.supabase_url.is_empty() {
            return Err("SUPABASE_URL is not configured on server".to_string());
        }

        match self.verify_via_jwks(token).await {
            Ok(user) => return Ok(user),
            Err(jwks_err) => {
                tracing::debug!(error = %jwks_err, "JWKS verification failed, trying /auth/v1/user fallback");
            }
        }

        self.verify_via_user_endpoint(token).await
    }

    async fn verify_via_jwks(&self, token: &str) -> Result<AuthenticatedUser, String> {
        let header = decode_header(token).map_err(|e| format!("invalid JWT header: {e}"))?;
        let jwks = self.get_or_refresh_jwks(header.kid.as_deref()).await?;

        let jwk = if let Some(kid) = header.kid.as_deref() {
            jwks.find(kid)
                .ok_or_else(|| format!("JWK kid '{kid}' not found"))?
        } else {
            jwks.keys
                .first()
                .ok_or_else(|| "JWKS contains no keys".to_string())?
        };

        let decoding_key = DecodingKey::from_jwk(jwk)
            .map_err(|e| format!("failed to construct decoding key from JWK: {e}"))?;

        let mut validation = Validation::new(header.alg);
        validation.set_audience(&["authenticated"]);
        validation.validate_exp = true;

        let token_data = decode::<SupabaseClaims>(token, &decoding_key, &validation)
            .map_err(|e| format!("JWT signature/claims validation failed: {e}"))?;

        if token_data.claims.sub.is_empty() {
            return Err("JWT missing sub claim".to_string());
        }

        Ok(AuthenticatedUser {
            user_id: token_data.claims.sub,
        })
    }

    async fn get_or_refresh_jwks(&self, expected_kid: Option<&str>) -> Result<JwkSet, String> {
        {
            let guard = self.jwks_cache.read().await;
            if let Some(cached) = guard.as_ref() {
                let fresh = cached.fetched_at.elapsed() < JWKS_CACHE_TTL;
                let has_kid = expected_kid.is_none_or(|kid| cached.jwks.find(kid).is_some());
                if fresh && has_kid {
                    return Ok(cached.jwks.clone());
                }
            }
        }

        let jwks_url = format!("{}/auth/v1/.well-known/jwks.json", self.supabase_url);
        let response = self
            .http
            .get(&jwks_url)
            .send()
            .await
            .map_err(|e| format!("JWKS request failed: {e}"))?;

        if !response.status().is_success() {
            return Err(format!("JWKS endpoint returned HTTP {}", response.status()));
        }

        let jwks: JwkSet = response
            .json()
            .await
            .map_err(|e| format!("failed to parse JWKS JSON: {e}"))?;

        let mut guard = self.jwks_cache.write().await;
        *guard = Some(CachedJwks {
            jwks: jwks.clone(),
            fetched_at: Instant::now(),
        });

        Ok(jwks)
    }

    async fn verify_via_user_endpoint(&self, token: &str) -> Result<AuthenticatedUser, String> {
        if self.publishable_key.is_empty() {
            return Err("SUPABASE_PUBLISHABLE_KEY is not configured for fallback verification".to_string());
        }

        let user_url = format!("{}/auth/v1/user", self.supabase_url);
        let response = self
            .http
            .get(&user_url)
            .header("apikey", &self.publishable_key)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| format!("Supabase /auth/v1/user request failed: {e}"))?;

        if !response.status().is_success() {
            return Err(format!(
                "Supabase /auth/v1/user rejected token with HTTP {}",
                response.status()
            ));
        }

        let user: SupabaseUserResponse = response
            .json()
            .await
            .map_err(|e| format!("invalid Supabase user payload: {e}"))?;

        if user.id.is_empty() {
            return Err("Supabase user response had empty id".to_string());
        }

        Ok(AuthenticatedUser { user_id: user.id })
    }
}

fn is_safe_id(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok()
}
