import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react'
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'
import { Highlight, themes } from 'prism-react-renderer'
import type { Session } from '@supabase/supabase-js'
import {
  ArrowDownToLine, ArrowLeft, ArrowRight, Braces, Check, ChevronLeft, ChevronRight, Code2, Copy, FileCode2,
  FolderPlus, LayoutDashboard, LogOut, Menu, Pencil, Plus, Search, Settings2,
  Moon, ShieldCheck, Sparkles, Sun, Trash2, Upload, X,
} from 'lucide-react'
import { Toaster, toast } from 'react-hot-toast'
import clsx from 'clsx'
import { twMerge } from 'tailwind-merge'
import type { Category, CodeBlock, User } from './types'
import { supabase, usernameToSyntheticEmail } from './lib/supabase'
import { readStore, writeStore, STORAGE_ERROR_EVENT, STORAGE_KEYS } from './utils/storage'
import './index.css'

const LANGUAGES = ['JavaScript', 'TypeScript', 'React', 'Java', 'PHP', 'HTML', 'CSS', 'Python', 'SQL', 'JSON', 'Bash', 'Other']
const THEME_STORAGE_KEY = 'cbl_theme'
type Theme = 'light' | 'dark'
type UserAction = 'approve' | 'reject' | 'toggle'
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,30}[A-Za-z0-9]$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function cn(...values: Parameters<typeof clsx>) {
  return twMerge(clsx(...values))
}

function displayName(user: User) {
  return user.role === 'superadmin' ? 'Administrator' : user.username
}

function mapProfile(profile: { id: string; username: string; role: User['role']; status: User['status']; enabled: boolean; created_at: string }): User {
  return { id: profile.id, username: profile.username, role: profile.role, status: profile.status, enabled: profile.enabled, createdAt: timestampOrNow(profile.created_at) }
}

function mapCollection(collection: { id: string; name: string; created_at: string }): Category {
  return { id: collection.id, name: collection.name, createdAt: timestampOrNow(collection.created_at) }
}

function mapSnippet(snippet: { id: string; collection_id: string; title: string; language: string; code: string; created_at: string; updated_at: string }): CodeBlock {
  return { id: snippet.id, categoryId: snippet.collection_id, title: snippet.title, language: snippet.language, code: snippet.code, createdAt: timestampOrNow(snippet.created_at), updatedAt: timestampOrNow(snippet.updated_at) }
}

function timestampOrNow(value: unknown) {
  return isValidDate(value) ? value : new Date().toISOString()
}

async function loadLibraryForUser(user: User) {
  const [collectionsResult, snippetsResult] = await Promise.all([
    supabase.from('collections').select('*').order('created_at', { ascending: false }),
    supabase.from('snippets').select('*').order('updated_at', { ascending: false }),
  ])
  if (collectionsResult.error) throw collectionsResult.error
  if (snippetsResult.error) throw snippetsResult.error

  let users = [user]
  if (user.role === 'superadmin') {
    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('id, username, role, status, enabled, created_at')
      .order('created_at', { ascending: true })
    if (error) throw error
    users = (profiles ?? []).map(mapProfile)
  }

  return {
    categories: (collectionsResult.data ?? []).map(mapCollection),
    blocks: (snippetsResult.data ?? []).map(mapSnippet),
    users,
  }
}

function openFilePicker(fileRef: RefObject<HTMLInputElement>) {
  fileRef.current?.click()
}

function focusSearchInput(searchRef: RefObject<HTMLInputElement>) {
  searchRef.current?.focus()
}

function AppFrame() {
  const [users, setUsers] = useState<User[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [blocks, setBlocks] = useState<CodeBlock[]>([])
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [theme, setTheme] = useState<Theme>(() => {
    const storedTheme = readStore<unknown>(THEME_STORAGE_KEY, 'light')
    return storedTheme === 'dark' ? 'dark' : 'light'
  })
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [dashboardSidebarCollapsed, setDashboardSidebarCollapsed] = useState(false)
  const [collectionSidebarCollapsed, setCollectionSidebarCollapsed] = useState(false)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const suppressSignedInRef = useRef(false)
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => {
    const closeSidebarOnHistoryNavigation = () => setSidebarOpen(false)
    window.addEventListener('popstate', closeSidebarOnHistoryNavigation)
    return () => window.removeEventListener('popstate', closeSidebarOnHistoryNavigation)
  }, [])
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    writeStore(THEME_STORAGE_KEY, theme)
  }, [theme])
  useEffect(() => {
    const reportStorageError = (event: Event) => toast.error((event as CustomEvent<string>).detail)
    window.addEventListener(STORAGE_ERROR_EVENT, reportStorageError)
    return () => window.removeEventListener(STORAGE_ERROR_EVENT, reportStorageError)
  }, [])
  useEffect(() => {
    let active = true
    let requestId = 0

    const loadSession = async (session: Session | null) => {
      const currentRequest = ++requestId
      if (!session) {
        setCurrentUser(null)
        setUsers([])
        setCategories([])
        setBlocks([])
        setLoading(false)
        return
      }

      setLoading(true)
      try {
        const { data: profile, error: profileError } = await supabase
          .from('profiles')
          .select('id, username, role, status, enabled, created_at')
          .eq('id', session.user.id)
          .maybeSingle()
        if (profileError) throw profileError
        if (!active || currentRequest !== requestId) return
        if (!profile || profile.status !== 'approved' || !profile.enabled) {
          setCurrentUser(null)
          setUsers([])
          setCategories([])
          setBlocks([])
          await supabase.auth.signOut()
          return
        }

        const user = mapProfile(profile)
        const library = await loadLibraryForUser(user)

        if (!active || currentRequest !== requestId) return
        setCurrentUser(user)
        setCategories(library.categories)
        setBlocks(library.blocks)
        setUsers(library.users)
      } catch (error) {
        if (active && currentRequest === requestId) {
          const message = error instanceof Error ? error.message : 'Unexpected Supabase error.'
          toast.error(`Unable to load your library: ${message}`)
        }
      } finally {
        if (active && currentRequest === requestId) setLoading(false)
      }
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'INITIAL_SESSION' || (event === 'SIGNED_IN' && suppressSignedInRef.current)) return
      window.setTimeout(() => {
        if (active) void loadSession(session)
      }, 0)
    })
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'hidden') return
      void supabase.auth.getSession().then(({ data, error }) => {
        if (!active) return
        if (error) {
          toast.error(`Unable to refresh your Supabase session: ${error.message}`)
          return
        }
        void loadSession(data.session)
      })
    }
    window.addEventListener('focus', refreshWhenVisible)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    void supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return
      if (error) {
        toast.error(`Unable to restore your Supabase session: ${error.message}`)
        setLoading(false)
        return
      }
      void loadSession(data.session)
    })

    return () => {
      active = false
      subscription.unsubscribe()
      window.removeEventListener('focus', refreshWhenVisible)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && currentUser) {
        event.preventDefault()
        searchRef.current?.focus()
      }
      if (event.key === 'Escape') {
        setDialog(null)
        setSidebarOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [currentUser])

  const isAdmin = currentUser?.role === 'superadmin'
  const globalResults = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return { categories: [], blocks: [] }
    return {
      categories: categories.filter((category) => category.name.toLowerCase().includes(normalized)).slice(0, 4),
      blocks: blocks.filter((block) => `${block.title} ${block.language} ${block.code}`.toLowerCase().includes(normalized)).slice(0, 6),
    }
  }, [query, categories, blocks])

  const authenticate = async (username: string, password: string): Promise<void> => {
    const cleanUsername = username.trim()
    if (!cleanUsername) {
      toast.error('Enter your username')
      return
    }
    let signInResult: Awaited<ReturnType<typeof supabase.auth.signInWithPassword>>
    suppressSignedInRef.current = true
    try {
      signInResult = await supabase.auth.signInWithPassword({
        email: usernameToSyntheticEmail(cleanUsername),
        password,
      })
    } finally {
      suppressSignedInRef.current = false
    }
    const { data, error } = signInResult
    if (error) {
      toast.error(error.message)
      return
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, username, role, status, enabled, created_at')
      .eq('id', data.user.id)
      .maybeSingle()
    if (profileError) {
      await supabase.auth.signOut()
      toast.error(`Unable to load your profile: ${profileError.message}`)
      return
    }
    if (!profile) {
      await supabase.auth.signOut()
      toast.error('Your account profile was not found.')
      return
    }
    if (profile.status !== 'approved') {
      await supabase.auth.signOut()
      toast.error(profile.status === 'pending' ? 'Your account is awaiting approval' : 'This account has been rejected')
      return
    }
    if (!profile.enabled) {
      await supabase.auth.signOut()
      toast.error('Your account has been disabled')
      return
    }
    const user = mapProfile(profile)
    try {
      const library = await loadLibraryForUser(user)
      setCurrentUser(user)
      setCategories(library.categories)
      setBlocks(library.blocks)
      setUsers(library.users)
    } catch (loadError) {
      await supabase.auth.signOut()
      toast.error(`Unable to load your library: ${loadError instanceof Error ? loadError.message : 'Unexpected Supabase error.'}`)
      return
    }
    toast.success(`Welcome back, ${profile.username}`)
    navigate('/')
  }
  const register = async (username: string, password: string) => {
    const cleanUsername = username.trim()
    if (!USERNAME_PATTERN.test(cleanUsername)) {
      toast.error('Use 3–32 letters, numbers, dots, underscores, or hyphens; start and end with a letter or number.')
      return false
    }
    const { data, error } = await supabase.auth.signUp({
      email: usernameToSyntheticEmail(cleanUsername),
      password,
      options: { data: { username: cleanUsername } },
    })
    if (error) {
      toast.error(error.message)
      return false
    }
    if (!data.user) {
      toast.error('Supabase did not return a user. Check the Auth email-confirmation settings and try again.')
      return false
    }
    toast.success('Account created. It is pending admin approval.', { duration: 6000 })
    navigate('/login')
    return true
  }
  const logout = async () => {
    try {
      const { error } = await supabase.auth.signOut()
      if (error) return toast.error(`Unable to sign out: ${error.message}`)
      setCurrentUser(null)
      setUsers([])
      setCategories([])
      setBlocks([])
      setQuery('')
      setSidebarOpen(false)
      navigate('/login')
      toast.success('You have been signed out')
    } catch (error) {
      toast.error(`Unable to sign out: ${error instanceof Error ? error.message : 'Unexpected Supabase error.'}`)
    }
  }
  const saveCategory = async (name: string, id?: string) => {
    if (!isAdmin) return toast.error('Only the superadmin can change collections.')
    const clean = name.trim()
    if (!clean) return toast.error('Enter a category name')
    if (categories.some((item) => item.name.toLowerCase() === clean.toLowerCase() && item.id !== id)) return toast.error('A category with that name already exists')
    try {
      if (id) {
        const { data, error } = await supabase.from('collections').update({ name: clean }).eq('id', id).select('id').maybeSingle()
        if (error) throw error
        if (!data) throw new Error('The collection was not found or you do not have permission to update it.')
        setCategories((old) => old.map((item) => item.id === id ? { ...item, name: clean } : item))
      } else {
        const { data, error } = await supabase.from('collections').insert({ name: clean }).select('*').single()
        if (error) throw error
        setCategories((old) => [mapCollection(data), ...old])
      }
      setDialog(null)
      toast.success(id ? 'Collection updated' : 'Collection created')
    } catch (error) {
      toast.error(`Unable to save collection: ${error instanceof Error ? error.message : 'Unexpected Supabase error.'}`)
    }
  }
  const deleteCategory = async (category: Category) => {
    if (!isAdmin) return toast.error('Only the superadmin can delete collections.')
    const count = blocks.filter((block) => block.categoryId === category.id).length
    if (!window.confirm(`Delete "${category.name}"${count ? ` and its ${count} code block${count === 1 ? '' : 's'}` : ''}? This cannot be undone.`)) return
    try {
      const { data, error } = await supabase.from('collections').delete().eq('id', category.id).select('id').maybeSingle()
      if (error) return toast.error(`Unable to delete collection: ${error.message}`)
      if (!data) return toast.error('The collection was not found or you do not have permission to delete it.')
      setCategories((old) => old.filter((item) => item.id !== category.id))
      setBlocks((old) => old.filter((item) => item.categoryId !== category.id))
      toast.success('Collection deleted')
    } catch (error) {
      toast.error(`Unable to delete collection: ${error instanceof Error ? error.message : 'Unexpected Supabase error.'}`)
    }
  }
  const saveBlock = async (value: Omit<CodeBlock, 'id' | 'createdAt' | 'updatedAt'>, id?: string) => {
    if (!isAdmin) return toast.error('Only the superadmin can change snippets.')
    if (!value.title.trim() || !value.code.trim()) return toast.error('Add a title and code before saving')
    const now = new Date().toISOString()
    try {
      if (id) {
        const { data, error } = await supabase.from('snippets').update({
          collection_id: value.categoryId,
          title: value.title.trim(),
          language: value.language,
          code: value.code,
          updated_at: now,
        }).eq('id', id).select('*').single()
        if (error) throw error
        const updatedBlock = mapSnippet(data)
        setBlocks((old) => old.map((item) => item.id === id ? updatedBlock : item))
      } else {
        const { data, error } = await supabase.from('snippets').insert({
          collection_id: value.categoryId,
          title: value.title.trim(),
          language: value.language,
          code: value.code,
          created_at: now,
          updated_at: now,
        }).select('*').single()
        if (error) throw error
        setBlocks((old) => [mapSnippet(data), ...old])
      }
      setDialog(null)
      toast.success(id ? 'Snippet updated' : 'Snippet created')
    } catch (error) {
      toast.error(`Unable to save snippet: ${error instanceof Error ? error.message : 'Unexpected Supabase error.'}`)
    }
  }
  const deleteBlock = async (block: CodeBlock) => {
    if (!isAdmin) return toast.error('Only the superadmin can delete snippets.')
    if (!window.confirm(`Delete "${block.title}"? This cannot be undone.`)) return
    try {
      const { data, error } = await supabase.from('snippets').delete().eq('id', block.id).select('id').maybeSingle()
      if (error) return toast.error(`Unable to delete snippet: ${error.message}`)
      if (!data) return toast.error('The snippet was not found or you do not have permission to delete it.')
      setBlocks((old) => old.filter((item) => item.id !== block.id))
      if (location.pathname.includes(`/block/${block.id}`)) navigate(`/category/${block.categoryId}`)
      toast.success('Snippet deleted')
    } catch (error) {
      toast.error(`Unable to delete snippet: ${error instanceof Error ? error.message : 'Unexpected Supabase error.'}`)
    }
  }
  const updateUser = async (id: string, action: UserAction) => {
    if (!isAdmin || !currentUser || id === currentUser.id) return toast.error('You cannot change your own access.')
    const target = users.find((user) => user.id === id)
    if (!target || target.role === 'superadmin') return toast.error('The superadmin account cannot be changed.')
    const update = action === 'approve'
      ? { status: 'approved' as const, enabled: true }
      : action === 'reject'
        ? { status: 'rejected' as const, enabled: false }
        : { enabled: !target.enabled }
    try {
      const { data, error } = await supabase.from('profiles')
        .update(update)
        .eq('id', id)
        .select('id, username, role, status, enabled, created_at')
        .maybeSingle()
      if (error) return toast.error(`Unable to update member: ${error.message}`)
      if (!data) return toast.error('The member was not found or you do not have permission to update this profile.')
      const updatedUser = mapProfile(data)
      setUsers((old) => old.map((user) => user.id === id ? updatedUser : user))
      toast.success(action === 'approve' ? 'User approved and enabled' : action === 'reject' ? 'User rejected and disabled' : `User ${updatedUser.enabled ? 'enabled' : 'disabled'}`)
    } catch (error) {
      toast.error(`Unable to update member: ${error instanceof Error ? error.message : 'Unexpected Supabase error.'}`)
    }
  }
  const exportData = () => {
    const payload = { categories, codeblocks: blocks }
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `codeblock-library-${new Date().toISOString().slice(0, 10)}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    toast.success('Your library export is ready. It contains no account data.')
  }
  const importLibrary = async (data: unknown) => {
    if (!isAdmin) return toast.error('Only the superadmin can import library data.')
    try {
      if (!data || typeof data !== 'object') throw new Error('The file is not a valid library export')
      const value = data as Partial<{ categories: unknown[]; codeblocks: unknown[]; blocks: unknown[] }>
      const rawBlocks = value.codeblocks ?? value.blocks
      if (!Array.isArray(value.categories) || !Array.isArray(rawBlocks)) throw new Error('The import must include categories and codeblocks arrays')
      if (!value.categories.every(isCategory) || !rawBlocks.every(isCodeBlock)) throw new Error('The import contains invalid library records')

      const importedCategories = value.categories as Category[]
      const importedBlocks = rawBlocks as CodeBlock[]
      if (new Set(importedCategories.map((item) => item.id)).size !== importedCategories.length
        || new Set(importedBlocks.map((item) => item.id)).size !== importedBlocks.length) {
        throw new Error('The import contains duplicate record IDs.')
      }
      if (!window.confirm('Importing will add or update matching library records. Existing rows not in the file will be kept. Continue?')) return

      const now = new Date().toISOString()
      const categoryIdMap = new Map<string, string>()
      const collectionRows = importedCategories.map((category) => {
        const id = UUID_PATTERN.test(category.id) ? category.id : crypto.randomUUID()
        categoryIdMap.set(category.id, id)
        return {
          id,
          name: category.name.trim(),
          created_at: isValidDate(category.createdAt) ? category.createdAt : now,
        }
      })
      const existingCategoryIds = new Set(categories.map((category) => category.id))
      const snippetRows = importedBlocks.map((block) => {
        const collectionId = categoryIdMap.get(block.categoryId) ?? block.categoryId
        if (!categoryIdMap.has(block.categoryId) && !existingCategoryIds.has(collectionId)) {
          throw new Error(`Snippet "${block.title}" refers to a collection that is not in this import or the current library.`)
        }
        return {
          id: UUID_PATTERN.test(block.id) ? block.id : crypto.randomUUID(),
          collection_id: collectionId,
          title: block.title.trim(),
          language: block.language,
          code: block.code,
          created_at: isValidDate(block.createdAt) ? block.createdAt : now,
          updated_at: isValidDate(block.updatedAt) ? block.updatedAt : now,
        }
      })

      const { data: savedCollections, error: collectionError } = await supabase
        .from('collections').upsert(collectionRows, { onConflict: 'id' }).select('*')
      if (collectionError) throw collectionError
      setCategories((old) => mergeById(old, (savedCollections ?? []).map(mapCollection)))

      const { data: savedSnippets, error: snippetError } = await supabase
        .from('snippets').upsert(snippetRows, { onConflict: 'id' }).select('*')
      if (snippetError) throw snippetError
      setBlocks((old) => mergeById(old, (savedSnippets ?? []).map(mapSnippet)))
      toast.success('Library data imported. Existing localStorage data was left untouched.')
    } catch (error) {
      toast.error(`Unable to import library data: ${error instanceof Error ? error.message : 'Unexpected Supabase error.'}`)
    }
  }
  const importData = async (file: File) => {
    try {
      await importLibrary(JSON.parse(await file.text()) as unknown)
    } catch (error) {
      toast.error(`Unable to read import file: ${error instanceof Error ? error.message : 'Invalid JSON.'}`)
    }
  }
  const importLegacyData = async () => {
    try {
      const categoriesValue = window.localStorage.getItem(STORAGE_KEYS.categories)
      const blocksValue = window.localStorage.getItem(STORAGE_KEYS.blocks)
      if (!categoriesValue && !blocksValue) throw new Error('No legacy collections or snippets were found in this browser.')
      await importLibrary({
        categories: categoriesValue ? JSON.parse(categoriesValue) as unknown : [],
        codeblocks: blocksValue ? JSON.parse(blocksValue) as unknown : [],
      })
    } catch (error) {
      toast.error(`Unable to read this browser's saved data: ${error instanceof Error ? error.message : 'Invalid local data.'}`)
    }
  }

  const protectedContent = (content: ReactNode, adminOnly = false) => {
    if (loading) return <LoadingPage />
    if (!currentUser) return <Navigate to="/login" replace state={{ from: location.pathname }} />
    if (adminOnly && !isAdmin) return <Navigate to="/" replace />
    return <AppLayout
      user={currentUser}
      canManageLibrary={isAdmin}
      theme={theme}
      onToggleTheme={() => setTheme((old) => old === 'light' ? 'dark' : 'light')}
      categories={categories}
      blocks={blocks}
      selectedCategory={categories.find((category) => category.id === location.pathname.match(/^\/category\/([^/]+)/)?.[1]) ?? null}
      selectedBlockId={location.pathname.match(/^\/category\/[^/]+\/block\/([^/]+)/)?.[1] ?? null}
      query={query}
      setQuery={setQuery}
      searchRef={searchRef}
      searchResults={globalResults}
      sidebarOpen={sidebarOpen}
      setSidebarOpen={setSidebarOpen}
      dashboardSidebarCollapsed={dashboardSidebarCollapsed}
      collectionSidebarCollapsed={collectionSidebarCollapsed}
      onToggleSidebar={() => {
        if (location.pathname.startsWith('/category/')) setCollectionSidebarCollapsed((collapsed) => !collapsed)
        else setDashboardSidebarCollapsed((collapsed) => !collapsed)
      }}
      logout={logout}
      onAddCategory={() => setDialog({ kind: 'category' })}
      onAddBlock={(categoryId) => setDialog({ kind: 'block', categoryId })}
      onExport={exportData}
      onImport={importData}
      onImportLegacy={importLegacyData}
    >{content}</AppLayout>
  }

  return (
    <>
      <Toaster position="top-right" toastOptions={{ duration: 3000, style: { borderRadius: 14, fontSize: 14, fontWeight: 600, background: 'var(--surface)', color: 'var(--text)' } }} />
      <Routes>
        <Route path="/login" element={currentUser ? <Navigate to="/" replace /> : <AuthPage mode="login" onLogin={authenticate} onRegister={register} />} />
        <Route path="/register" element={currentUser ? <Navigate to="/" replace /> : <AuthPage mode="register" onLogin={authenticate} onRegister={register} />} />
        <Route path="/" element={protectedContent(<Dashboard categories={categories} blocks={blocks} canManageLibrary={isAdmin} onAdd={() => setDialog({ kind: 'category' })} onEdit={(category) => setDialog({ kind: 'category', category })} onDelete={deleteCategory} query={query} onQueryChange={setQuery} />)} />
        <Route path="/category/:categoryId" element={protectedContent(<CategoryPage categories={categories} blocks={blocks} canManageLibrary={isAdmin} onAdd={(categoryId) => setDialog({ kind: 'block', categoryId })} onEdit={(block) => setDialog({ kind: 'block', categoryId: block.categoryId, block })} onDelete={deleteBlock} />)} />
        <Route path="/category/:categoryId/block/:blockId" element={protectedContent(<BlockDetail categories={categories} blocks={blocks} canManageLibrary={isAdmin} onEdit={(block) => setDialog({ kind: 'block', categoryId: block.categoryId, block })} onDelete={deleteBlock} />)} />
        <Route path="/admin" element={protectedContent(<AdminPage users={users} currentUserId={currentUser?.id ?? ''} onUpdate={updateUser} />, true)} />
        <Route path="*" element={<NotFound />} />
      </Routes>
      {currentUser && isAdmin && dialog && <Dialog state={dialog} categories={categories} onClose={() => setDialog(null)} onSaveCategory={saveCategory} onSaveBlock={saveBlock} />}
    </>
  )
}

type DialogState = { kind: 'category'; category?: Category } | { kind: 'block'; categoryId: string; block?: CodeBlock }

function AppLayout(props: {
  user: User; canManageLibrary: boolean; theme: Theme; onToggleTheme: () => void; categories: Category[]; blocks: CodeBlock[]; selectedCategory: Category | null; selectedBlockId: string | null; query: string; setQuery: (value: string) => void; searchRef: RefObject<HTMLInputElement>
  searchResults: { categories: Category[]; blocks: CodeBlock[] }; sidebarOpen: boolean; setSidebarOpen: (open: boolean) => void
  dashboardSidebarCollapsed: boolean; collectionSidebarCollapsed: boolean; onToggleSidebar: () => void
  logout: () => void; onAddCategory: () => void; onAddBlock: (categoryId: string) => void; onExport: () => void; onImport: (file: File) => void; onImportLegacy: () => void; children: ReactNode
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const [showResults, setShowResults] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const isAdmin = props.canManageLibrary
  const isMobile = window.matchMedia('(max-width: 760px)').matches
  const collectionMode = props.selectedCategory !== null
  const collapsed = collectionMode ? props.collectionSidebarCollapsed : props.dashboardSidebarCollapsed
  const collectionBlocks = collectionMode ? props.blocks.filter((block) => block.categoryId === props.selectedCategory?.id) : []
  const triggerImport = () => {
    openFilePicker(fileRef)
    props.setSidebarOpen(false)
  }
  const clearGlobalSearch = () => {
    props.setQuery('')
    setShowResults(false)
    focusSearchInput(props.searchRef)
  }
  return (
    <div className={cn('app-shell', collapsed && 'sidebar-collapsed', collectionMode && 'collection-sidebar-mode', props.sidebarOpen && 'sidebar-overlay-open')}>
      {props.sidebarOpen && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => props.setSidebarOpen(false)} />}
      <button
        className="icon-btn sidebar-toggle"
        aria-label={isMobile ? props.sidebarOpen ? 'Close sidebar' : 'Open sidebar' : collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        title={isMobile ? props.sidebarOpen ? 'Close sidebar' : 'Open sidebar' : collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        onClick={() => {
          if (isMobile) props.setSidebarOpen(!props.sidebarOpen)
          else props.onToggleSidebar()
        }}
      >
        {collapsed && !isMobile || isMobile && !props.sidebarOpen ? <ChevronRight size={17} /> : <ChevronLeft size={17} />}
      </button>
      <aside className={cn('sidebar', props.sidebarOpen && 'sidebar-open')}>
        <div className="sidebar-topline">
          <Link to="/" className="brand" aria-label="CodeBlock Library — Overview" title="Go to Overview" onClick={() => props.setSidebarOpen(false)}><span className="brand-mark"><Braces size={21} /></span><span>Code<span className="brand-light">Block</span><small>LIBRARY</small></span></Link>
        </div>
        <div className={cn('sidebar-mode-content', collectionMode ? 'sidebar-mode-collection' : 'sidebar-mode-dashboard')} key={collectionMode ? `collection-${props.selectedCategory?.id}` : 'dashboard'}>
          {collectionMode ? <>
            <button className="collection-context" title={props.selectedCategory?.name} onClick={() => { navigate('/'); props.setSidebarOpen(false) }}><ArrowLeft size={17} /><span>{props.selectedCategory?.name}</span></button>
            <div className="side-label">IN THIS COLLECTION</div>
            <div className="collection-side-heading"><span>Code blocks</span><span className="collection-block-count">{collectionBlocks.length}</span></div>
            <nav className="category-nav block-nav">
              {collectionBlocks.map((block) => <Link key={block.id} to={`/category/${props.selectedCategory?.id}/block/${block.id}`} className={cn('nav-item nav-category block-nav-item', props.selectedBlockId === block.id && 'nav-active')} title={collapsed ? block.title : undefined} onClick={() => props.setSidebarOpen(false)}><FileCode2 size={17} /><span>{block.title}</span></Link>)}
              {!collectionBlocks.length && <div className="side-empty">{collapsed ? <FileCode2 size={17} /> : 'No code blocks in this collection yet.'}</div>}
            </nav>
            {isAdmin && <button className="side-add-button" title={collapsed ? 'Add code block' : undefined} onClick={() => { if (!props.selectedCategory) return; props.onAddBlock(props.selectedCategory.id); props.setSidebarOpen(false) }}><Plus size={16} /><span>Add Code Block</span></button>}
          </> : <>
            <div className="side-label">YOUR WORKSPACE</div>
            <Link to="/" title={collapsed ? 'Overview' : undefined} className={cn('nav-item', location.pathname === '/' && 'nav-active')} onClick={() => props.setSidebarOpen(false)}><LayoutDashboard size={18} /><span>Overview</span></Link>
            <div className="side-section-heading"><span>Collections</span>{isAdmin && <button className="icon-btn side-plus" aria-label="Add collection" title="Add collection" onClick={() => { props.onAddCategory(); props.setSidebarOpen(false) }}><Plus size={16} /></button>}</div>
            <nav className="category-nav">
              {props.categories.map((category) => <Link key={category.id} to={`/category/${category.id}`} title={collapsed ? category.name : undefined} className={cn('nav-item nav-category', props.selectedCategory?.id === category.id && 'nav-active')} onClick={() => props.setSidebarOpen(false)}><FolderPlus size={17} /><span>{category.name}</span></Link>)}
              {!props.categories.length && <div className="side-empty">{collapsed ? <FolderPlus size={17} /> : 'Your collections will show up here.'}</div>}
            </nav>
            {isAdmin && <button className="side-add-button dashboard-add-button" title={collapsed ? 'Add collection' : undefined} onClick={() => { props.onAddCategory(); props.setSidebarOpen(false) }}><Plus size={16} /><span>Add Collection</span></button>}
          </>}
        </div>
        <div className="sidebar-bottom">
          <div className="side-tools">
            <button title={collapsed ? 'Export library' : undefined} onClick={() => { props.onExport(); props.setSidebarOpen(false) }}><ArrowDownToLine size={16} /><span>Export library</span></button>
            {isAdmin && <>
              <button title={collapsed ? 'Import data' : undefined} onClick={triggerImport}><Upload size={16} /><span>Import data</span></button>
              <button title={collapsed ? 'Import this browser’s saved data' : undefined} onClick={() => { props.onImportLegacy(); props.setSidebarOpen(false) }}><Upload size={16} /><span>Import this browser’s saved data</span></button>
            </>}
            <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) props.onImport(file); event.target.value = '' }} />
          </div>
          <div className="profile-row"><span className="avatar">{displayName(props.user).slice(0, 1).toUpperCase()}</span><div className="profile-meta"><strong>{displayName(props.user)}</strong><small>{isAdmin ? 'Super admin' : 'Library member'}</small></div><button className="icon-btn profile-logout" aria-label="Log out" title="Log out" onClick={props.logout}><LogOut size={17} /></button></div>
        </div>
      </aside>
      <section className="main-column">
        <header className="topbar">
          <Link to="/" className="icon-btn dashboard-nav-button" aria-label="Go to Dashboard" title="Go to Dashboard" onClick={() => props.setSidebarOpen(false)}><Menu size={20} /></Link>
          <div className="global-search-wrap">
            <Search size={18} />
            <input ref={props.searchRef} value={props.query} placeholder="Search your library..." onChange={(event) => { props.setQuery(event.target.value); setShowResults(true) }} onFocus={() => setShowResults(true)} onKeyDown={(event) => { if (event.key === 'Escape') setShowResults(false); if (event.key === 'Enter' && props.searchResults.blocks[0]) { navigate(`/category/${props.searchResults.blocks[0].categoryId}/block/${props.searchResults.blocks[0].id}`); props.setQuery(''); setShowResults(false) } }} />
            {props.query && <button className="search-clear" type="button" aria-label="Clear search" title="Clear search" onClick={clearGlobalSearch}><X size={15} /></button>}
            <kbd>⌘ K</kbd>
            {showResults && props.query.trim() && <><button className="search-dismiss" aria-label="Dismiss search results" onClick={() => setShowResults(false)} /><div className="search-results">
              {!props.searchResults.categories.length && !props.searchResults.blocks.length ? <p className="search-none">No matches found for “{props.query}”</p> : <>
                {props.searchResults.categories.length > 0 && <><div className="result-label">CATEGORIES</div>{props.searchResults.categories.map((category) => <Link key={category.id} to={`/category/${category.id}`} className="result-item" onClick={() => { props.setQuery(''); setShowResults(false) }}><FolderPlus size={16} />{category.name}<ArrowRight size={14} /></Link>)}</>}
                {props.searchResults.blocks.length > 0 && <><div className="result-label">CODE BLOCKS</div>{props.searchResults.blocks.map((block) => <Link key={block.id} to={`/category/${block.categoryId}/block/${block.id}`} className="result-item" onClick={() => { props.setQuery(''); setShowResults(false) }}><FileCode2 size={16} /><span>{block.title}<small>{block.language}</small></span><ArrowRight size={14} /></Link>)}</>}
              </>}
            </div></>}
          </div>
          <div className="topbar-right">{isAdmin && <Link className={cn('admin-link', location.pathname === '/admin' && 'admin-link-active')} to="/admin"><ShieldCheck size={16} /><span>Admin panel</span></Link>}<button className="theme-toggle icon-btn" aria-label={`Switch to ${props.theme === 'light' ? 'dark' : 'light'} mode`} title={`Switch to ${props.theme === 'light' ? 'dark' : 'light'} mode`} onClick={props.onToggleTheme}>{props.theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}</button><span className="online-indicator"><i /> Supabase</span><div className="top-user"><span className="avatar avatar-top">{displayName(props.user).slice(0, 1).toUpperCase()}</span><span className="top-user-name">{displayName(props.user)}</span><button className="icon-btn" aria-label="Log out" title="Log out" onClick={props.logout}><LogOut size={16} /></button></div></div>
        </header>
        <main className="page-content">{props.children}</main>
      </section>
    </div>
  )
}

function AuthPage({ mode, onLogin, onRegister }: {
  mode: 'login' | 'register'
  onLogin: (username: string, password: string) => Promise<void>
  onRegister: (username: string, password: string) => Promise<boolean>
}) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const isRegister = mode === 'register'
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    try {
      if (isRegister) {
        if (!USERNAME_PATTERN.test(username.trim())) return toast.error('Use 3–32 letters, numbers, dots, underscores, or hyphens; start and end with a letter or number.')
        if (password.length < 6) return toast.error('Password must be at least 6 characters')
        if (password !== confirm) return toast.error('Passwords do not match')
        if (await onRegister(username.trim(), password)) {
          setUsername('')
          setPassword('')
          setConfirm('')
        }
      } else {
        await onLogin(username.trim(), password)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to complete authentication.')
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <div className="auth-page">
      <div className="auth-side"><div className="auth-brand"><span className="brand-mark"><Braces size={21} /></span>Code<span className="brand-light">Block</span></div><div className="auth-hero"><span className="eyebrow"><Sparkles size={14} /> YOUR PERSONAL CODE VAULT</span><h1>Every great idea<br />starts with a <em>snippet.</em></h1><p>A home for the little pieces of code that make your next big thing possible.</p><div className="auth-preview"><div className="preview-top"><span /><span /><span /><small>useful-snippet.ts</small></div><pre><span className="syntax-pink">const</span> <span className="syntax-blue">idea</span> = <span className="syntax-yellow">"save it for later"</span>;<br /><br /><span className="syntax-pink">function</span> <span className="syntax-green">buildSomethingGreat</span>() {'{'}<br />&nbsp;&nbsp;<span className="syntax-pink">return</span> idea + <span className="syntax-yellow">" ✨"</span>;<br />{'}'}</pre></div></div><div className="auth-side-foot">A little more organized. A lot more inspired.</div></div>
      <div className="auth-main"><div className="auth-mobile-brand"><span className="brand-mark"><Braces size={19} /></span>Code<span className="brand-light">Block</span></div><form className="auth-card" onSubmit={submit}><div className="auth-icon">{isRegister ? <Sparkles size={21} /> : <Code2 size={22} />}</div><div className="auth-heading"><h2>{isRegister ? 'Create your account' : 'Welcome back'}</h2><p>{isRegister ? 'Start collecting your favorite snippets.' : 'Sign in to pick up where you left off.'}</p></div>
        <label className="field-label">Username<input autoFocus autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Enter your username" required minLength={isRegister ? 3 : undefined} maxLength={isRegister ? 32 : undefined} pattern={isRegister ? '[A-Za-z0-9][A-Za-z0-9_.-]{1,30}[A-Za-z0-9]' : undefined} /></label>
        <label className="field-label">Password<div className="password-wrap"><input type={showPassword ? 'text' : 'password'} autoComplete={isRegister ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" required minLength={isRegister ? 6 : undefined} /><button type="button" className="show-password" onClick={() => setShowPassword(!showPassword)}>{showPassword ? 'Hide' : 'Show'}</button></div></label>
        {isRegister && <label className="field-label">Confirm password<input type={showPassword ? 'text' : 'password'} autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} placeholder="Repeat your password" required /></label>}
        <button className="button button-primary auth-submit" type="submit" disabled={submitting}>{isRegister ? 'Create account' : 'Sign in'}<ArrowRight size={17} /></button>
        <p className="auth-switch">{isRegister ? 'Already have an account?' : 'New to CodeBlock?'} <Link to={isRegister ? '/login' : '/register'}>{isRegister ? 'Sign in' : 'Create an account'}</Link></p>
      </form><div className="auth-footer">Your code snippets, right where you need them.</div></div>
    </div>
  )
}

function Dashboard({ categories, blocks, canManageLibrary, onAdd, onEdit, onDelete, query, onQueryChange }: { categories: Category[]; blocks: CodeBlock[]; canManageLibrary: boolean; onAdd: () => void; onEdit: (category: Category) => void; onDelete: (category: Category) => void; query: string; onQueryChange: (value: string) => void }) {
  const search = query.toLowerCase()
  const filtered = categories.filter((category) => category.name.toLowerCase().includes(search))
  const latest = [...blocks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4)
  return <div className="page-wrap">
    <div className="welcome-strip"><div><div className="eyebrow">YOUR DEVELOPER WORKSPACE</div><h1>Good ideas, <span>kept close.</span></h1><p>All your reusable code, organized and ready for the next build.</p></div><div className="welcome-art"><div className="art-glow" /><div className="art-card art-card-back"><span>npm run build</span><i /></div><div className="art-card art-card-front"><Braces size={29} /><span>ship it</span><Sparkles size={15} /></div><span className="art-sparkle">✳</span></div></div>
    <div className="stats-row"><div className="stat-card"><span className="stat-icon sky"><FolderPlus size={19} /></span><div><strong>{categories.length}</strong><small>Collections</small></div></div><div className="stat-card"><span className="stat-icon violet"><FileCode2 size={19} /></span><div><strong>{blocks.length}</strong><small>Code snippets</small></div></div><div className="stat-card"><span className="stat-icon mint"><Sparkles size={19} /></span><div><strong>{new Set(blocks.map((block) => block.language)).size}</strong><small>Languages</small></div></div></div>
    <section className="section-block"><div className="section-header"><div><h2>Your collections</h2><p>Keep related snippets together.</p></div><div className="section-actions"><div className="inline-search"><Search size={16} /><input placeholder="Filter categories" value={query} onChange={(event) => onQueryChange(event.target.value)} />{query && <button className="search-clear" type="button" aria-label="Clear category search" title="Clear search" onClick={() => onQueryChange('')}><X size={14} /></button>}</div>{canManageLibrary && <button className="button button-primary" onClick={onAdd}><Plus size={17} /> New collection</button>}</div></div>
      {loadingSkeletonOrEmpty(filtered.length === 0, categories.length === 0, query, canManageLibrary, onAdd)}
      <div className="category-grid">{filtered.map((category, index) => {
        const count = blocks.filter((block) => block.categoryId === category.id).length
        return <article className="category-card" key={category.id} style={{ animationDelay: `${index * 45}ms` }}><div className="category-card-top"><span className={cn('folder-tile', `folder-${index % 5}`)}><FolderPlus size={21} /></span>{canManageLibrary && <div className="card-actions"><button className="icon-btn" aria-label={`Edit ${category.name}`} onClick={() => onEdit(category)}><Pencil size={15} /></button><button className="icon-btn danger-hover" aria-label={`Delete ${category.name}`} onClick={() => onDelete(category)}><Trash2 size={15} /></button></div>}</div><Link to={`/category/${category.id}`} className="category-title">{category.name}<ArrowRight size={16} /></Link><p>{count} {count === 1 ? 'snippet' : 'snippets'} <span>·</span> added {new Date(category.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</p><div className="category-card-bottom"><span>OPEN COLLECTION</span><span className="count-bubble">{String(count).padStart(2, '0')}</span></div></article>
      })}</div>
    </section>
    {latest.length > 0 && <section className="section-block recent-section"><div className="section-header"><div><h2>Recently updated</h2><p>Pick up where you left off.</p></div></div><div className="recent-grid">{latest.map((block) => <Link className="recent-card" to={`/category/${block.categoryId}/block/${block.id}`} key={block.id}><span className="recent-code-icon"><Code2 size={18} /></span><div><strong>{block.title}</strong><small>{categories.find((category) => category.id === block.categoryId)?.name ?? 'Unknown collection'}</small></div><span className="language-chip">{block.language}</span></Link>)}</div></section>}
  </div>
}

function loadingSkeletonOrEmpty(isEmpty: boolean, noCategories: boolean, query: string, canManageLibrary: boolean, onAdd: () => void) {
  if (!isEmpty) return null
  return <div className="empty-state"><div className="empty-illustration"><FolderPlus size={29} /><Sparkles className="empty-sparkle" size={16} /></div><h3>{query ? 'No collections match' : noCategories ? 'Make room for good ideas' : 'Nothing found'}</h3><p>{query ? 'Try another search term or start a new collection.' : 'Create your first collection and start saving code worth keeping.'}</p>{!query && canManageLibrary && <button className="button button-primary" onClick={onAdd}><Plus size={16} /> Create a collection</button>}</div>
}

function CategoryPage({ categories, blocks, canManageLibrary, onAdd, onEdit, onDelete }: { categories: Category[]; blocks: CodeBlock[]; canManageLibrary: boolean; onAdd: (categoryId: string) => void; onEdit: (block: CodeBlock) => void; onDelete: (block: CodeBlock) => void }) {
  const { categoryId } = useParams()
  const category = categories.find((item) => item.id === categoryId)
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const matching = blocks.filter((block) => block.categoryId === categoryId && `${block.title} ${block.language} ${block.code}`.toLowerCase().includes(search.toLowerCase()))
  if (!category) return <Navigate to="/" replace />
  return <div className="page-wrap">
    <div className="breadcrumbs"><Link to="/">Collections</Link><span>/</span><span>{category.name}</span></div>
    <div className="category-heading"><div><div className="heading-kicker"><span className="heading-dot" /> COLLECTION</div><h1>{category.name}</h1><p>{blocks.filter((block) => block.categoryId === category.id).length} reusable snippets in this collection</p></div>{canManageLibrary && <button className="button button-primary" onClick={() => onAdd(category.id)}><Plus size={17} /> Add code block</button>}</div>
    <div className="list-toolbar"><div className="inline-search list-search"><Search size={17} /><input placeholder="Search title, language or code..." value={search} onChange={(event) => setSearch(event.target.value)} /></div><span>{matching.length} {matching.length === 1 ? 'snippet' : 'snippets'}</span></div>
    {matching.length === 0 ? <div className="empty-state list-empty"><div className="empty-illustration"><Code2 size={29} /></div><h3>{search ? 'No snippets match your search' : 'This collection is ready for its first snippet'}</h3><p>{search ? 'Try a different title, language, or code keyword.' : 'Save a useful function, a command, or anything you want to reuse later.'}</p>{!search && canManageLibrary && <button className="button button-primary" onClick={() => onAdd(category.id)}><Plus size={16} /> Add a code block</button>}</div> :
      <div className="snippet-grid">{matching.map((block, index) => <SnippetCard key={block.id} block={block} index={index} canManageLibrary={canManageLibrary} onEdit={onEdit} onDelete={onDelete} onOpen={() => navigate(`/category/${categoryId}/block/${block.id}`)} />)}</div>}
  </div>
}

function SnippetCard({ block, index, canManageLibrary, onEdit, onDelete, onOpen }: { block: CodeBlock; index: number; canManageLibrary: boolean; onEdit: (block: CodeBlock) => void; onDelete: (block: CodeBlock) => void; onOpen: () => void }) {
  return <article className="snippet-card" style={{ animationDelay: `${index * 45}ms` }}><div className="snippet-card-head"><button className="snippet-title-button" onClick={onOpen}><strong>{block.title}</strong><ArrowRight size={16} /></button>{canManageLibrary && <div className="snippet-card-actions"><button className="icon-btn" aria-label={`Edit ${block.title}`} onClick={() => onEdit(block)}><Pencil size={15} /></button><button className="icon-btn danger-hover" aria-label={`Delete ${block.title}`} onClick={() => onDelete(block)}><Trash2 size={15} /></button></div>}</div><span className="language-chip">{block.language}</span><button className="code-preview-button" onClick={onOpen} aria-label={`Open ${block.title}`}><CodePreview code={block.code} language={block.language} compact /></button><div className="snippet-card-footer"><span>UPDATED {new Date(block.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase()}</span><button className="copy-small" onClick={() => copyText(block.code)}><Copy size={14} /> Copy</button></div></article>
}

function BlockDetail({ categories, blocks, canManageLibrary, onEdit, onDelete }: { categories: Category[]; blocks: CodeBlock[]; canManageLibrary: boolean; onEdit: (block: CodeBlock) => void; onDelete: (block: CodeBlock) => void }) {
  const { categoryId, blockId } = useParams()
  const navigate = useNavigate()
  const block = blocks.find((item) => item.id === blockId)
  const category = categories.find((item) => item.id === categoryId)
  if (!block || !category) return <Navigate to={category ? `/category/${category.id}` : '/'} replace />
  return <div className="page-wrap detail-page">
    <div className="breadcrumbs"><Link to="/">Collections</Link><span>/</span><Link to={`/category/${category.id}`}>{category.name}</Link><span>/</span><span>{block.title}</span></div>
    <div className="detail-back-row"><button className="back-button" onClick={() => navigate(`/category/${category.id}`)}><ArrowLeft size={17} /> Back to {category.name}</button>{canManageLibrary && <div className="detail-actions"><button className="button button-secondary" onClick={() => onEdit(block)}><Pencil size={16} /> Edit snippet</button><button className="icon-btn danger-hover detail-delete" aria-label="Delete code block" onClick={() => onDelete(block)}><Trash2 size={17} /></button></div>}</div>
    <div className="detail-title-row"><div><div className="heading-kicker"><span className="heading-dot" /> CODE SNIPPET</div><h1>{block.title}</h1><p>In <Link to={`/category/${category.id}`}>{category.name}</Link> · Updated {new Date(block.updatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</p></div><span className="language-chip language-large">{block.language}</span></div>
    <div className="detail-code-shell"><div className="detail-code-top"><div className="window-dots"><i /><i /><i /></div><span>{block.title}.{languageExtension(block.language)}</span><button className="copy-code-btn" onClick={() => copyText(block.code)}><Copy size={15} /> Copy code</button></div><CodePreview code={block.code} language={block.language} /></div>
    <div className="detail-footnote"><ShieldCheck size={15} /> Shared privately with approved library members.</div>
  </div>
}

function CodePreview({ code, language, compact = false }: { code: string; language: string; compact?: boolean }) {
  const normalized = prismLanguage(language)
  const visibleCode = compact ? code.split('\n').slice(0, 7).join('\n') : code
  return <div className={cn('code-highlight', compact && 'code-highlight-compact')}><Highlight theme={themes.vsDark} code={visibleCode} language={normalized as Parameters<typeof Highlight>[0]['language']}>{({ className, style, tokens, getLineProps, getTokenProps }) => <pre className={className} style={style}>{tokens.map((line, lineIndex) => <div key={lineIndex} {...getLineProps({ line })}><span className="line-number">{lineIndex + 1}</span><span className="line-content">{line.map((token, tokenIndex) => <span key={tokenIndex} {...getTokenProps({ token })} />)}</span></div>)}</pre>}</Highlight></div>
}

function AdminPage({ users, currentUserId, onUpdate }: { users: User[]; currentUserId: string; onUpdate: (id: string, action: UserAction) => void }) {
  const pending = users.filter((user) => user.status === 'pending' && user.role !== 'superadmin')
  return <div className="page-wrap admin-page"><div className="admin-hero"><div><div className="eyebrow">WORKSPACE SETTINGS</div><h1>Admin panel</h1><p>Manage access and keep your workspace in good shape.</p></div><span className="admin-shield"><ShieldCheck size={27} /></span></div>
    <div className="admin-stats"><div><span className="admin-stat-icon blue"><UsersIcon /></span><strong>{users.filter((user) => user.role !== 'superadmin').length}</strong><small>Total members</small></div><div><span className="admin-stat-icon orange"><Settings2 size={18} /></span><strong>{pending.length}</strong><small>Awaiting approval</small></div><div><span className="admin-stat-icon green"><Check size={19} /></span><strong>{users.filter((user) => user.status === 'approved' && user.enabled && user.role !== 'superadmin').length}</strong><small>Active accounts</small></div></div>
    <section className="admin-section"><div className="admin-section-heading"><div><h2>Pending requests</h2><p>Review new members before they can sign in.</p></div><span className={cn('pending-counter', pending.length > 0 && 'pending-counter-active')}>{pending.length} pending</span></div>{pending.length === 0 ? <div className="admin-empty"><span><Check size={18} /></span><div><strong>All caught up</strong><p>There are no accounts waiting for approval.</p></div></div> : <div className="pending-list">{pending.map((user) => <div className="user-row" key={user.id}><span className="avatar">{user.username.slice(0, 1).toUpperCase()}</span><div className="user-info"><strong>{user.username}</strong><small>Requested access to your library</small></div><span className="status-pill status-pending">Pending</span><button className="button button-approve" onClick={() => onUpdate(user.id, 'approve')}><Check size={15} /> Approve</button><button className="button button-reject" onClick={() => onUpdate(user.id, 'reject')}>Reject</button></div>)}</div>}</section>
    <section className="admin-section"><div className="admin-section-heading"><div><h2>All members</h2><p>Enable or disable access for existing accounts.</p></div><span className="member-count">{users.length} accounts</span></div><div className="user-table-wrap"><table className="user-table"><thead><tr><th>MEMBER</th><th>STATUS</th><th>ACCESS</th><th className="actions-header">ACTIONS</th></tr></thead><tbody>{users.map((user) => <tr key={user.id}><td><div className="table-user"><span className={cn('avatar', user.role === 'superadmin' && 'avatar-admin')}>{displayName(user).slice(0, 1).toUpperCase()}</span><div><strong>{displayName(user)}</strong><small>{user.role === 'superadmin' ? 'Workspace owner' : 'Member'}</small></div></div></td><td><span className={cn('status-pill', `status-${user.status}`)}>{user.status}</span></td><td><span className={cn('access-indicator', user.enabled && 'access-enabled')}><i />{user.enabled ? 'Enabled' : 'Disabled'}</span></td><td><div className="table-actions">{user.role === 'superadmin' || user.id === currentUserId ? <span className="owner-tag"><ShieldCheck size={14} /> Owner</span> : <button className={cn('button', user.enabled ? 'button-disable' : 'button-enable')} onClick={() => onUpdate(user.id, 'toggle')}>{user.enabled ? 'Disable' : 'Enable'}</button>}</div></td></tr>)}</tbody></table></div></section>
  </div>
}

function UsersIcon() { return <span className="users-glyph">♙</span> }

function Dialog({ state, categories, onClose, onSaveCategory, onSaveBlock }: { state: DialogState; categories: Category[]; onClose: () => void; onSaveCategory: (name: string, id?: string) => void; onSaveBlock: (value: Omit<CodeBlock, 'id' | 'createdAt' | 'updatedAt'>, id?: string) => void }) {
  if (state.kind === 'category') return <Modal title={state.category ? 'Rename collection' : 'Create a collection'} subtitle="Give your snippets a place to call home." onClose={onClose}><CategoryForm category={state.category} onClose={onClose} onSave={onSaveCategory} /></Modal>
  const category = categories.find((item) => item.id === state.categoryId)
  return <Modal title={state.block ? 'Edit code block' : 'Add a code block'} subtitle={`Save a reusable snippet${category ? ` in ${category.name}` : ''}.`} onClose={onClose} wide><BlockForm categoryId={state.categoryId} block={state.block} onClose={onClose} onSave={onSaveBlock} /></Modal>
}

function Modal({ title, subtitle, onClose, children, wide = false }: { title: string; subtitle: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => { const oldOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => { document.body.style.overflow = oldOverflow } }, [])
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className={cn('modal-panel', wide && 'modal-wide')} role="dialog" aria-modal="true" aria-labelledby="modal-title"><header className="modal-header"><div><h2 id="modal-title">{title}</h2><p>{subtitle}</p></div><button className="icon-btn modal-close" aria-label="Close" onClick={onClose}><X size={19} /></button></header>{children}</section></div>
}

function CategoryForm({ category, onClose, onSave }: { category?: Category; onClose: () => void; onSave: (name: string, id?: string) => void }) {
  const [name, setName] = useState(category?.name ?? '')
  return <form className="modal-form" onSubmit={(event) => { event.preventDefault(); onSave(name, category?.id) }}><label className="field-label">Collection name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Frontend utilities" maxLength={60} required /></label><div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>Cancel</button><button className="button button-primary" type="submit">{category ? 'Save changes' : 'Create collection'}</button></div></form>
}

function BlockForm({ categoryId, block, onClose, onSave }: { categoryId: string; block?: CodeBlock; onClose: () => void; onSave: (value: Omit<CodeBlock, 'id' | 'createdAt' | 'updatedAt'>, id?: string) => void }) {
  const [title, setTitle] = useState(block?.title ?? '')
  const [language, setLanguage] = useState(block?.language ?? 'JavaScript')
  const [code, setCode] = useState(block?.code ?? '')
  return <form className="modal-form block-form" onSubmit={(event) => { event.preventDefault(); onSave({ categoryId, title, language, code }, block?.id) }}><div className="form-two-col"><label className="field-label">Snippet title<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Debounce utility" maxLength={100} required /></label><label className="field-label">Language<select value={language} onChange={(event) => setLanguage(event.target.value)}>{LANGUAGES.map((item) => <option key={item}>{item}</option>)}</select></label></div><label className="field-label">Code<textarea className="code-textarea" value={code} onChange={(event) => setCode(event.target.value)} placeholder="Paste or write your code here..." spellCheck={false} required /></label><div className="modal-actions"><span className="character-count">{code.length.toLocaleString()} characters</span><button type="button" className="button button-secondary" onClick={onClose}>Cancel</button><button className="button button-primary" type="submit">{block ? 'Save changes' : 'Save code block'}</button></div></form>
}

function NotFound() {
  return <div className="not-found"><div className="not-found-icon"><Code2 size={28} /></div><span className="eyebrow">404 · LOST IN THE BRACKETS</span><h1>Nothing to see here.</h1><p>The page you’re looking for has wandered off into another file.</p><Link className="button button-primary" to="/"><ArrowLeft size={16} /> Back to your library</Link></div>
}

function LoadingPage() { return <div className="loading-screen"><div className="loading-brand"><span className="brand-mark"><Braces size={21} /></span>Code<span className="brand-light">Block</span></div><div className="skeleton-content"><div className="skeleton skeleton-title" /><div className="skeleton skeleton-description" /><div className="skeleton-row"><div className="skeleton skeleton-stat" /><div className="skeleton skeleton-stat" /><div className="skeleton skeleton-stat" /></div><div className="skeleton-row"><div className="skeleton skeleton-card" /><div className="skeleton skeleton-card" /><div className="skeleton skeleton-card" /></div></div></div> }

async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); toast.success('Copied to clipboard') }
  catch { toast.error('Clipboard access is unavailable in this browser') }
}
function prismLanguage(language: string) {
  const aliases: Record<string, string> = { JavaScript: 'jsx', TypeScript: 'tsx', React: 'jsx', HTML: 'markup', PHP: 'php', CSS: 'css', Java: 'java', Python: 'python', SQL: 'sql', JSON: 'json', Bash: 'bash' }
  return aliases[language] ?? 'plaintext'
}
function languageExtension(language: string) {
  const extensions: Record<string, string> = { JavaScript: 'js', TypeScript: 'tsx', React: 'jsx', HTML: 'html', CSS: 'css', PHP: 'php', Java: 'java', Python: 'py', SQL: 'sql', JSON: 'json', Bash: 'sh' }
  return extensions[language] ?? 'txt'
}
function isCategory(value: unknown): value is Category {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string' && Boolean(item.id) && typeof item.name === 'string' && Boolean(item.name.trim()) && typeof item.createdAt === 'string'
}
function isCodeBlock(value: unknown): value is CodeBlock {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string' && Boolean(item.id) && typeof item.categoryId === 'string' && Boolean(item.categoryId) && typeof item.title === 'string' && Boolean(item.title.trim()) && typeof item.language === 'string' && typeof item.code === 'string' && typeof item.createdAt === 'string' && typeof item.updatedAt === 'string'
}

function isValidDate(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value))
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]) {
  const merged = new Map(current.map((item) => [item.id, item]))
  incoming.forEach((item) => merged.set(item.id, item))
  return Array.from(merged.values())
}

export default function App() {
  return <BrowserRouter><AppFrame /></BrowserRouter>
}
