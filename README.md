# CodeBlock Library

A responsive library for reusable code snippets. Built with React 18, TypeScript, Vite, Tailwind CSS, React Router, and Supabase.

## Run locally

Install dependencies and start the development server:

```sh
npm install
npm run dev
```

Create a production build with `npm run build`.

## Supabase configuration

Set these Vite environment variables in a private `.env.local` file and in the deployment environment:

```dotenv
VITE_SUPABASE_URL=your-project-url
VITE_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
```

Do not put a service-role key in frontend code. `.env.local` is ignored by Git. Supabase Auth must have email confirmation disabled because usernames are mapped to synthetic `@login.codeblocklibrary.invalid` aliases. The existing superadmin identity and its Supabase Auth account are preserved; no credentials are embedded in the application.

## Initial superadmin setup

1. In Supabase SQL Editor, run `supabase/migrations/003_remove_superadmin_bootstrap.sql` after `001_initial_schema.sql`. This installs the Dashboard-compatible trigger and removes any previously installed bootstrap objects. `002_first_superadmin_bootstrap.sql` is historical; do not run it for this setup.
2. In Supabase Auth settings, disable email confirmation.
3. Open **Authentication → Users → Add User**. Enter the username as the synthetic email alias, for example `myusername@login.codeblocklibrary.invalid`, and set the password.
4. The trigger creates a profile with role `user`, status `pending`, and `enabled = false`. When username metadata is absent, it derives and validates the username from the synthetic email alias.
5. Copy the new Auth user's UUID from the Dashboard and run this one statement in Supabase SQL Editor, replacing the placeholder:

   ```sql
   UPDATE public.profiles
   SET role = 'superadmin', status = 'approved', enabled = true
   WHERE id = 'AUTH_USER_UUID'::uuid
     AND role::text = 'user'
     AND status::text = 'pending'
     AND enabled = false
     AND NOT EXISTS (
       SELECT 1 FROM public.profiles WHERE role::text = 'superadmin'
     );
   ```

The existing unique-superadmin index prevents a second superadmin. Existing RLS policies continue to prevent ordinary users from changing their own role or access state; perform the one-time promotion in SQL Editor as the project owner.

## Access and library data

New accounts are created as pending and disabled. A superadmin must approve and enable them before they can read the shared library. Approved and enabled members can read collections and snippets; only the superadmin can create, edit, or delete library records and manage other profiles.

Collections, snippets, and profiles are stored in Supabase. The app keeps the selected light/dark theme in localStorage. Existing localStorage library data is left untouched.

## Importing existing data

Sign in as the superadmin and use **Import this browser's saved data** to import the old `cbl_categories` and `cbl_codeblocks` data from the current browser. You can also import a JSON export containing `categories` and `codeblocks` arrays. Imports upsert by ID and preserve valid UUIDs, relationships, and timestamps; non-UUID legacy IDs are replaced with new UUIDs and snippet relationships are remapped. Existing rows are not deleted, and user records or passwords are never imported. The old localStorage values remain in the browser so you can verify the Supabase copy before clearing anything manually.

Exported JSON contains only collections and snippets, never users or credentials. Imports are performed through browser requests and are not transactional: if a snippet import fails after collections are saved, the collections remain and can safely be re-imported after correcting the issue.

## Features

- Create, rename, and delete collections; deleting a collection also deletes its snippets.
- Create, edit, search, syntax-highlight, and copy code snippets.
- Approve, reject, enable, and disable member accounts.
- Export and import library data as JSON.
- Search the library globally with `Ctrl/Cmd + K`.
- Responsive sidebar navigation and mobile layout.