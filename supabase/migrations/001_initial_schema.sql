-- Data-preserving migration for the existing CodeBlock Library tables.
-- This migration does not create, drop, or recreate data tables.

BEGIN;

DO $preflight$
DECLARE
  required_column record;
BEGIN
  IF pg_catalog.to_regclass('public.profiles') IS NULL
    OR pg_catalog.to_regclass('public.collections') IS NULL
    OR pg_catalog.to_regclass('public.snippets') IS NULL
  THEN
    RAISE EXCEPTION
      'Expected existing public.profiles, public.collections, and public.snippets tables';
  END IF;

  FOR required_column IN
    SELECT *
    FROM (VALUES
      ('profiles', 'id'),
      ('profiles', 'username'),
      ('profiles', 'role'),
      ('profiles', 'status'),
      ('profiles', 'enabled'),
      ('collections', 'id'),
      ('collections', 'name'),
      ('snippets', 'id'),
      ('snippets', 'collection_id'),
      ('snippets', 'title'),
      ('snippets', 'language'),
      ('snippets', 'code')
    ) AS expected(table_name, column_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns AS column_info
      WHERE column_info.table_schema = 'public'
        AND column_info.table_name = required_column.table_name
        AND column_info.column_name = required_column.column_name
    ) THEN
      RAISE EXCEPTION 'Required column public.%.% is missing',
        required_column.table_name, required_column.column_name;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles'
      AND column_name = 'id' AND udt_name = 'uuid'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'collections'
      AND column_name = 'id' AND udt_name = 'uuid'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'snippets'
      AND column_name = 'id' AND udt_name = 'uuid'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'snippets'
      AND column_name = 'collection_id' AND udt_name = 'uuid'
  ) THEN
    RAISE EXCEPTION
      'Existing ID columns must be UUIDs to preserve the application IDs and relationship';
  END IF;

  IF pg_catalog.to_regprocedure('public.handle_new_user()') IS NULL
    OR (
      SELECT count(*)
      FROM pg_catalog.pg_trigger AS trigger_info
      WHERE trigger_info.tgrelid = 'auth.users'::pg_catalog.regclass
        AND trigger_info.tgname = 'on_auth_user_created'
        AND trigger_info.tgfoid =
          'public.handle_new_user()'::pg_catalog.regprocedure
        AND NOT trigger_info.tgisinternal
        AND trigger_info.tgenabled IN ('O', 'A')
        AND (trigger_info.tgtype & 4) <> 0
    ) <> 1
  THEN
    RAISE EXCEPTION
      'Expected one enabled auth.users trigger named on_auth_user_created calling public.handle_new_user()';
  END IF;
END;
$preflight$;

-- Add only missing timestamp columns; existing values are not rewritten.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS created_at timestamp with time zone
  NOT NULL DEFAULT pg_catalog.now();
ALTER TABLE public.collections
  ADD COLUMN IF NOT EXISTS created_at timestamp with time zone
  NOT NULL DEFAULT pg_catalog.now();
ALTER TABLE public.snippets
  ADD COLUMN IF NOT EXISTS created_at timestamp with time zone
  NOT NULL DEFAULT pg_catalog.now();
ALTER TABLE public.snippets
  ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone
  NOT NULL DEFAULT pg_catalog.now();

ALTER TABLE public.profiles
  ALTER COLUMN created_at SET DEFAULT pg_catalog.now();
ALTER TABLE public.collections
  ALTER COLUMN created_at SET DEFAULT pg_catalog.now();
ALTER TABLE public.snippets
  ALTER COLUMN created_at SET DEFAULT pg_catalog.now(),
  ALTER COLUMN updated_at SET DEFAULT pg_catalog.now();

-- Preserve existing profile rows, but fail rather than silently normalize
-- unexpected role/status values. Replace only single-column role/status checks.
DO $profile_checks$
DECLARE
  role_attnum smallint;
  status_attnum smallint;
  existing_check record;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.profiles
    WHERE role IS NULL OR role::text NOT IN ('user', 'superadmin')
       OR status IS NULL
       OR status::text NOT IN ('pending', 'approved', 'rejected')
  ) THEN
    RAISE EXCEPTION
      'Existing profile role/status values need review before migration';
  END IF;

  SELECT attnum INTO role_attnum
  FROM pg_catalog.pg_attribute
  WHERE attrelid = 'public.profiles'::pg_catalog.regclass
    AND attname = 'role' AND NOT attisdropped;

  SELECT attnum INTO status_attnum
  FROM pg_catalog.pg_attribute
  WHERE attrelid = 'public.profiles'::pg_catalog.regclass
    AND attname = 'status' AND NOT attisdropped;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_info
    WHERE constraint_info.conrelid = 'public.profiles'::pg_catalog.regclass
      AND constraint_info.contype = 'c'
      AND pg_catalog.cardinality(constraint_info.conkey) > 1
      AND (
        role_attnum = ANY (constraint_info.conkey)
        OR status_attnum = ANY (constraint_info.conkey)
      )
  ) THEN
    RAISE EXCEPTION
      'A combined role/status check exists; review it before migration';
  END IF;

  FOR existing_check IN
    SELECT constraint_info.conname
    FROM pg_catalog.pg_constraint AS constraint_info
    WHERE constraint_info.conrelid = 'public.profiles'::pg_catalog.regclass
      AND constraint_info.contype = 'c'
      AND (
        constraint_info.conkey = ARRAY[role_attnum]::smallint[]
        OR constraint_info.conkey = ARRAY[status_attnum]::smallint[]
      )
  LOOP
    EXECUTE pg_catalog.format(
      'ALTER TABLE public.profiles DROP CONSTRAINT %I',
      existing_check.conname
    );
  END LOOP;

  ALTER TABLE public.profiles
    ADD CONSTRAINT cbl_profiles_role_check
    CHECK (role::text IN ('user', 'superadmin'));
  ALTER TABLE public.profiles
    ADD CONSTRAINT cbl_profiles_status_check
    CHECK (status::text IN ('pending', 'approved', 'rejected'));
END;
$profile_checks$;

CREATE UNIQUE INDEX IF NOT EXISTS cbl_profiles_username_ci_uidx
  ON public.profiles (pg_catalog.lower(username));

CREATE UNIQUE INDEX IF NOT EXISTS cbl_profiles_one_superadmin_uidx
  ON public.profiles (role)
  WHERE role::text = 'superadmin';

-- Keep an existing correct cascade FK; replace only the snippets-to-
-- collections FK if its delete action is not CASCADE.
DO $collection_fk$
DECLARE
  snippet_collection_attnum smallint;
  collection_id_attnum smallint;
  existing_fk record;
  kept_cascade boolean := false;
BEGIN
  SELECT attnum INTO snippet_collection_attnum
  FROM pg_catalog.pg_attribute
  WHERE attrelid = 'public.snippets'::pg_catalog.regclass
    AND attname = 'collection_id' AND NOT attisdropped;

  SELECT attnum INTO collection_id_attnum
  FROM pg_catalog.pg_attribute
  WHERE attrelid = 'public.collections'::pg_catalog.regclass
    AND attname = 'id' AND NOT attisdropped;

  FOR existing_fk IN
    SELECT constraint_info.conname,
           constraint_info.conkey,
           constraint_info.confkey,
           constraint_info.confdeltype
    FROM pg_catalog.pg_constraint AS constraint_info
    WHERE constraint_info.conrelid = 'public.snippets'::pg_catalog.regclass
      AND constraint_info.confrelid = 'public.collections'::pg_catalog.regclass
      AND constraint_info.contype = 'f'
  LOOP
    IF existing_fk.conkey <> ARRAY[snippet_collection_attnum]::smallint[]
      OR existing_fk.confkey <> ARRAY[collection_id_attnum]::smallint[]
    THEN
      RAISE EXCEPTION
        'An unexpected snippets-to-collections foreign key exists; review it before migration';
    END IF;

    IF existing_fk.confdeltype = 'c' AND NOT kept_cascade THEN
      kept_cascade := true;
    ELSE
      EXECUTE pg_catalog.format(
        'ALTER TABLE public.snippets DROP CONSTRAINT %I',
        existing_fk.conname
      );
    END IF;
  END LOOP;

  IF NOT kept_cascade THEN
    ALTER TABLE public.snippets
      ADD CONSTRAINT cbl_snippets_collection_id_fkey
      FOREIGN KEY (collection_id)
      REFERENCES public.collections (id)
      ON DELETE CASCADE;
  END IF;
END;
$collection_fk$;

CREATE INDEX IF NOT EXISTS cbl_snippets_collection_id_idx
  ON public.snippets (collection_id);

-- Replace all policies on these three tables so older permissive policies
-- cannot combine with the intended access rules.
DO $drop_policies$
DECLARE
  existing_policy record;
BEGIN
  FOR existing_policy IN
    SELECT schemaname, tablename, policyname
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('profiles', 'collections', 'snippets')
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON public.%I',
      existing_policy.policyname,
      existing_policy.tablename
    );
  END LOOP;
END;
$drop_policies$;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.snippets ENABLE ROW LEVEL SECURITY;

-- Reuse the existing trigger. No second profile-creation trigger is added.
-- Existing role/status/enabled values are never read from client metadata.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  username_value text;
BEGIN
  username_value := pg_catalog.btrim(NEW.raw_user_meta_data ->> 'username');

  IF username_value IS NULL
    OR username_value !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{1,30}[A-Za-z0-9]$'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Invalid username';
  END IF;

  IF NEW.email IS NULL
    OR pg_catalog.lower(NEW.email) <>
       (pg_catalog.lower(username_value) || '@login.codeblocklibrary.invalid')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Auth email must be the synthetic username alias';
  END IF;

  BEGIN
    INSERT INTO public.profiles (id, username, role, status, enabled)
    VALUES (NEW.id, username_value, 'user', 'pending', false);
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'Username is already taken';
  END;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON TABLE public.profiles, public.collections, public.snippets
  FROM PUBLIC, anon, authenticated;

GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT ON TABLE public.profiles TO authenticated;
GRANT UPDATE (role, status, enabled) ON TABLE public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.collections, public.snippets
  TO authenticated;

CREATE POLICY cbl_profiles_select_self_or_superadmin
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (id = (SELECT auth.uid()) OR (SELECT public.is_superadmin()));

CREATE POLICY cbl_profiles_update_other_users
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING ((SELECT public.is_superadmin()) AND id <> (SELECT auth.uid()))
  WITH CHECK ((SELECT public.is_superadmin()) AND id <> (SELECT auth.uid()));

CREATE POLICY cbl_collections_select_approved_users
  ON public.collections
  FOR SELECT
  TO authenticated
  USING ((SELECT public.can_access_library()));

CREATE POLICY cbl_collections_insert_superadmin
  ON public.collections
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT public.is_superadmin()));

CREATE POLICY cbl_collections_update_superadmin
  ON public.collections
  FOR UPDATE
  TO authenticated
  USING ((SELECT public.is_superadmin()))
  WITH CHECK ((SELECT public.is_superadmin()));

CREATE POLICY cbl_collections_delete_superadmin
  ON public.collections
  FOR DELETE
  TO authenticated
  USING ((SELECT public.is_superadmin()));

CREATE POLICY cbl_snippets_select_approved_users
  ON public.snippets
  FOR SELECT
  TO authenticated
  USING ((SELECT public.can_access_library()));

CREATE POLICY cbl_snippets_insert_superadmin
  ON public.snippets
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT public.is_superadmin()));

CREATE POLICY cbl_snippets_update_superadmin
  ON public.snippets
  FOR UPDATE
  TO authenticated
  USING ((SELECT public.is_superadmin()))
  WITH CHECK ((SELECT public.is_superadmin()));

CREATE POLICY cbl_snippets_delete_superadmin
  ON public.snippets
  FOR DELETE
  TO authenticated
  USING ((SELECT public.is_superadmin()));

COMMIT;
