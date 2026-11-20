-- Fase 4 Hotfix: Estado autoritativo e sincronizado do Bot de Música por sala de voz
-- Elimina dependência de RAM entre múltiplas máquinas do servidor de sinalização e sobrevive a reinícios.

CREATE TABLE IF NOT EXISTS public.room_music_state (
  room_id TEXT PRIMARY KEY CHECK (
    char_length(room_id) BETWEEN 1 AND 128
    AND room_id ~ '^[A-Za-z0-9:_-]+$'
  ),
  current_track JSONB,
  queue JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_playing BOOLEAN NOT NULL DEFAULT FALSE,
  started_at_ms BIGINT NOT NULL DEFAULT 0,
  paused_offset_sec DOUBLE PRECISION NOT NULL DEFAULT 0,
  version BIGINT NOT NULL DEFAULT 1,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_room_music_state_updated_at
  ON public.room_music_state (updated_at DESC);

ALTER TABLE public.room_music_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "room_music_state_select_authenticated" ON public.room_music_state;
CREATE POLICY "room_music_state_select_authenticated"
  ON public.room_music_state
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) IS NOT NULL);

DROP POLICY IF EXISTS "room_music_state_insert_authenticated" ON public.room_music_state;
CREATE POLICY "room_music_state_insert_authenticated"
  ON public.room_music_state
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT auth.uid()) IS NOT NULL);

DROP POLICY IF EXISTS "room_music_state_update_authenticated" ON public.room_music_state;
CREATE POLICY "room_music_state_update_authenticated"
  ON public.room_music_state
  FOR UPDATE
  TO authenticated
  USING ((SELECT auth.uid()) IS NOT NULL)
  WITH CHECK ((SELECT auth.uid()) IS NOT NULL);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'room_music_state'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.room_music_state;
  END IF;
END
$$;
