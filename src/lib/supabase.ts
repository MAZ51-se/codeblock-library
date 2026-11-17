import { createClient } from '@supabase/supabase-js'

type ProfileRole = 'user' | 'superadmin'
type ProfileStatus = 'pending' | 'approved' | 'rejected'

type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string
          username: string
          role: ProfileRole
          status: ProfileStatus
          enabled: boolean
          created_at: string
        }
        Insert: {
          id: string
          username: string
          role?: ProfileRole
          status?: ProfileStatus
          enabled?: boolean
          created_at?: string
        }
        Update: {
          id?: string
          username?: string
          role?: ProfileRole
          status?: ProfileStatus
          enabled?: boolean
          created_at?: string
        }
        Relationships: []
      }
      collections: {
        Row: {
          id: string
          name: string
          created_at: string
        }
        Insert: {
          id?: string
          name: string
          created_at?: string
        }
        Update: {
          id?: string
          name?: string
          created_at?: string
        }
        Relationships: []
      }
      snippets: {
        Row: {
          id: string
          collection_id: string
          title: string
          language: string
          code: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          collection_id: string
          title: string
          language: string
          code: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          collection_id?: string
          title?: string
          language?: string
          code?: string
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (!supabaseUrl || !publishableKey) {
  throw new Error('Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY to connect to Supabase.')
}

export const supabase = createClient<Database>(supabaseUrl, publishableKey, {
  auth: {
    autoRefreshToken: true,
    detectSessionInUrl: true,
    persistSession: true,
  },
})

export function usernameToSyntheticEmail(username: string) {
  return `${username.trim().toLowerCase()}@login.codeblocklibrary.invalid`
}
