# CodeBlock Library

A responsive, local-first library for organizing reusable code snippets. Built with React 18, TypeScript, Vite, Tailwind CSS, React Router, Lucide, Prism, and react-hot-toast.

## Run locally

```sh
npm install
npm run dev
```

Create a production build with `npm run build`.

## Sign in

The built-in administrator account is:

- Username: `superadmin`
- Password: `admin@123`

Members can register from the sign-in page. New accounts remain pending until the administrator approves them.

## Features

- Create, rename, and delete collections; deleting a collection also deletes its snippets.
- Create, edit, search, syntax-highlight, and copy code snippets.
- Approve, reject, enable, disable, and remove member accounts.
- Export and import library data as JSON.
- Search the library globally with `Ctrl/Cmd + K`.
- Responsive sidebar navigation and mobile layout.

## Local data

The app stores its data in browser `localStorage`:

- `cbl_users`
- `cbl_currentUser`
- `cbl_categories`
- `cbl_codeblocks`

This is a client-only application: data does not sync between browsers or devices. Local-storage authentication and credentials are suitable for a private demo or personal tool, not for securing a multi-user production service. For that, use a backend with server-side authentication and authorization.
