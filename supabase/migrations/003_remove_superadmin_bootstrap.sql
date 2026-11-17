-- Remove the temporary secret-based bootstrap and support Dashboard-created
-- Auth users whose username is represented only by their synthetic email.
BEGIN;

DROP FUNCTION IF EXISTS public.cbl_bootstrap_first_superadmin(text);
DROP FUNCTION IF EXISTS public.cbl_bootstrap_first_superadmin();
DROP FUNCTION IF EXISTS public.cbl_is_superadmin_bootstrap_available();
DROP TABLE IF EXISTS public.cbl_bootstrap_state;

ALTER TABLE public.profiles
  DROP COLUMN IF EXISTS bootstrap_requested;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  username_value text;
  alias_email text;
BEGIN
  IF NEW.email IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Auth email must be a synthetic username alias';
  END IF;

  alias_email := pg_catalog.lower(NEW.email);
  IF alias_email !~ '^[a-z0-9][a-z0-9_.-]{1,30}[a-z0-9]@login\.codeblocklibrary\.invalid$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Auth email must be a valid synthetic username alias';
  END IF;

  username_value := NULLIF(
    pg_catalog.btrim(NEW.raw_user_meta_data ->> 'username'),
    ''
  );

  IF username_value IS NULL THEN
    username_value := pg_catalog.split_part(alias_email, '@', 1);
  ELSIF username_value !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{1,30}[A-Za-z0-9]$'
    OR alias_email <> (
      pg_catalog.lower(username_value) || '@login.codeblocklibrary.invalid'
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Username metadata must match the synthetic email alias';
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

COMMIT;
