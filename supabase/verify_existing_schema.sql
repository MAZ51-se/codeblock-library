-- Read-only preflight report for CodeBlock Library.
-- Every statement in this file is a SELECT. Run before the migration.

-- 1. Presence and RLS state of the target public tables.
WITH expected_tables (table_name) AS (
  VALUES ('profiles'), ('collections'), ('snippets')
)
SELECT
  expected.table_name,
  CASE
    WHEN relation.oid IS NULL THEN 'missing'
    WHEN relation.relkind IN ('r', 'p') THEN 'present'
    ELSE 'present, but not a regular/partitioned table'
  END AS object_status,
  relation.relrowsecurity AS row_level_security_enabled,
  relation.relforcerowsecurity AS row_level_security_forced
FROM expected_tables AS expected
LEFT JOIN pg_catalog.pg_namespace AS schema_info
  ON schema_info.nspname = 'public'
LEFT JOIN pg_catalog.pg_class AS relation
  ON relation.relnamespace = schema_info.oid
 AND relation.relname = expected.table_name
ORDER BY expected.table_name;

-- 2. Columns, SQL types, nullability, and defaults for public tables/views.
SELECT
  tables.table_name,
  tables.table_type,
  columns.ordinal_position,
  columns.column_name,
  columns.data_type,
  columns.udt_name,
  columns.is_nullable,
  columns.column_default,
  columns.character_maximum_length
FROM information_schema.columns AS columns
JOIN information_schema.tables AS tables
  ON tables.table_schema = columns.table_schema
 AND tables.table_name = columns.table_name
WHERE columns.table_schema = 'public'
ORDER BY columns.table_name, columns.ordinal_position;

-- 3. Constraints, including primary keys, unique/check constraints, and FKs,
-- for all public tables.
SELECT
  relation.relname AS table_name,
  constraint_info.conname AS constraint_name,
  CASE constraint_info.contype
    WHEN 'p' THEN 'primary key'
    WHEN 'u' THEN 'unique'
    WHEN 'f' THEN 'foreign key'
    WHEN 'c' THEN 'check'
    WHEN 'x' THEN 'exclusion'
    ELSE constraint_info.contype::text
  END AS constraint_type,
  pg_catalog.pg_get_constraintdef(constraint_info.oid, true) AS definition,
  constraint_info.convalidated AS is_validated
FROM pg_catalog.pg_constraint AS constraint_info
JOIN pg_catalog.pg_class AS relation
  ON relation.oid = constraint_info.conrelid
JOIN pg_catalog.pg_namespace AS schema_info
  ON schema_info.oid = relation.relnamespace
WHERE schema_info.nspname = 'public'
ORDER BY relation.relname, constraint_info.conname;

-- 4. Index definitions, including uniqueness and indexed expressions, for all
-- public tables.
SELECT
  indexes.schemaname AS schema_name,
  indexes.tablename AS table_name,
  indexes.indexname AS index_name,
  indexes.indexdef AS definition
FROM pg_catalog.pg_indexes AS indexes
WHERE indexes.schemaname = 'public'
ORDER BY indexes.tablename, indexes.indexname;

-- 5. RLS enabled state and every policy on all public tables.
SELECT
  relation.relname AS table_name,
  relation.relrowsecurity AS row_level_security_enabled,
  relation.relforcerowsecurity AS row_level_security_forced
FROM pg_catalog.pg_class AS relation
JOIN pg_catalog.pg_namespace AS schema_info
  ON schema_info.oid = relation.relnamespace
WHERE schema_info.nspname = 'public'
  AND relation.relkind IN ('r', 'p')
ORDER BY relation.relname;

SELECT
  policies.schemaname AS schema_name,
  policies.tablename AS table_name,
  policies.policyname AS policy_name,
  policies.permissive,
  policies.roles,
  policies.cmd AS command,
  policies.qual AS using_expression,
  policies.with_check AS check_expression
FROM pg_catalog.pg_policies AS policies
WHERE policies.schemaname = 'public'
ORDER BY policies.tablename, policies.policyname;

-- 6. User-defined triggers on all public tables and on auth.users.
SELECT
  table_schema.nspname AS table_schema,
  relation.relname AS table_name,
  trigger_info.tgname AS trigger_name,
  CASE trigger_info.tgenabled
    WHEN 'O' THEN 'enabled'
    WHEN 'D' THEN 'disabled'
    WHEN 'R' THEN 'replica'
    WHEN 'A' THEN 'always'
    ELSE trigger_info.tgenabled::text
  END AS trigger_state,
  function_schema.nspname || '.' || function_info.proname AS function_name,
  function_info.prosecdef AS function_is_security_definer,
  function_info.proconfig AS function_settings,
  pg_catalog.pg_get_triggerdef(trigger_info.oid, true) AS trigger_definition
FROM pg_catalog.pg_trigger AS trigger_info
JOIN pg_catalog.pg_class AS relation
  ON relation.oid = trigger_info.tgrelid
JOIN pg_catalog.pg_namespace AS table_schema
  ON table_schema.oid = relation.relnamespace
JOIN pg_catalog.pg_proc AS function_info
  ON function_info.oid = trigger_info.tgfoid
JOIN pg_catalog.pg_namespace AS function_schema
  ON function_schema.oid = function_info.pronamespace
WHERE NOT trigger_info.tgisinternal
  AND (
    table_schema.nspname = 'public'
    OR
    (table_schema.nspname = 'auth'
      AND relation.relname = 'users')
  )
ORDER BY table_schema.nspname, relation.relname, trigger_info.tgname;

-- 7. Definitions and security metadata for all ordinary public functions and
-- procedures. This includes complete definitions for the reported helpers.
SELECT
  function_schema.nspname AS function_schema,
  function_info.proname AS function_name,
  pg_catalog.pg_get_function_identity_arguments(function_info.oid) AS arguments,
  pg_catalog.pg_get_userbyid(function_info.proowner) AS function_owner,
  function_info.prokind AS function_kind,
  function_info.prosecdef AS is_security_definer,
  function_info.proconfig AS function_settings,
  pg_catalog.pg_get_functiondef(function_info.oid) AS complete_definition
FROM pg_catalog.pg_proc AS function_info
JOIN pg_catalog.pg_namespace AS function_schema
  ON function_schema.oid = function_info.pronamespace
WHERE function_schema.nspname = 'public'
  AND function_info.prokind IN ('f', 'p', 'w')
ORDER BY function_info.proname,
         pg_catalog.pg_get_function_identity_arguments(function_info.oid);

-- 8. Effective function EXECUTE ACL entries. A NULL proacl means PostgreSQL
-- defaults, so expand acldefault() rather than treating it as no permissions.
SELECT
  function_schema.nspname AS function_schema,
  function_info.proname AS function_name,
  pg_catalog.pg_get_function_identity_arguments(function_info.oid) AS arguments,
  CASE
    WHEN permission.grantee = 0 THEN 'PUBLIC'
    ELSE grantee_role.rolname
  END AS grantee,
  grantor_role.rolname AS grantor,
  permission.privilege_type,
  permission.is_grantable
FROM pg_catalog.pg_proc AS function_info
JOIN pg_catalog.pg_namespace AS function_schema
  ON function_schema.oid = function_info.pronamespace
CROSS JOIN LATERAL pg_catalog.aclexplode(
  COALESCE(
    function_info.proacl,
    pg_catalog.acldefault('f', function_info.proowner)
  )
) AS permission
LEFT JOIN pg_catalog.pg_roles AS grantee_role
  ON grantee_role.oid = permission.grantee
LEFT JOIN pg_catalog.pg_roles AS grantor_role
  ON grantor_role.oid = permission.grantor
WHERE function_schema.nspname = 'public'
  AND function_info.prokind IN ('f', 'p', 'w')
ORDER BY function_info.proname,
         pg_catalog.pg_get_function_identity_arguments(function_info.oid),
         grantee,
         permission.privilege_type;

-- 9. Catalog-recorded dependencies for the two access helpers and profile
-- trigger function. PL/pgSQL body references may not all be catalog-tracked.
SELECT
  function_schema.nspname AS function_schema,
  function_info.proname AS function_name,
  pg_catalog.pg_get_function_identity_arguments(function_info.oid) AS arguments,
  CASE
    WHEN dependency.refobjid IS NULL THEN 'No catalog-recorded dependencies'
    ELSE pg_catalog.pg_describe_object(
      dependency.refclassid,
      dependency.refobjid,
      dependency.refobjsubid
    )
  END AS dependency,
  dependency.deptype AS dependency_type
FROM pg_catalog.pg_proc AS function_info
JOIN pg_catalog.pg_namespace AS function_schema
  ON function_schema.oid = function_info.pronamespace
LEFT JOIN pg_catalog.pg_depend AS dependency
  ON dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
 AND dependency.objid = function_info.oid
WHERE function_schema.nspname = 'public'
  AND function_info.proname IN (
    'is_superadmin',
    'can_access_library',
    'handle_new_auth_user',
    'set_snippet_updated_at',
    'cbl_is_superadmin',
    'cbl_create_profile_on_auth_signup'
  )
ORDER BY function_info.proname,
         pg_catalog.pg_get_function_identity_arguments(function_info.oid),
         dependency.refclassid,
         dependency.refobjid,
         dependency.refobjsubid;
