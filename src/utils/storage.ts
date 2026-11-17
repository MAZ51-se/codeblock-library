export const STORAGE_KEYS = {
  users: 'cbl_users',
  currentUser: 'cbl_currentUser',
  categories: 'cbl_categories',
  blocks: 'cbl_codeblocks',
} as const
export const STORAGE_ERROR_EVENT = 'cbl:storage-error'

export function readStore<T>(key: string, fallback: T): T {
  const stored = window.localStorage.getItem(key)
  if (!stored) return fallback
  try {
    return JSON.parse(stored) as T
  } catch {
    console.error(`Unable to parse local storage key "${key}".`)
    return fallback
  }
}

export function writeStore<T>(key: string, value: T): void {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, JSON.stringify(value))
  } catch (error) {
    console.error(`Unable to save local storage key "${key}".`, error)
    window.dispatchEvent(new CustomEvent(STORAGE_ERROR_EVENT, {
      detail: 'Unable to save changes in this browser. Check that local storage is available.',
    }))
  }
}
