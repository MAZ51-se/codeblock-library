export type User = {
  id: string
  username: string
  status: 'pending' | 'approved' | 'rejected'
  enabled: boolean
  role: 'superadmin' | 'user'
  createdAt: string
}

export type Category = {
  id: string
  name: string
  createdAt: string
}

export type CodeBlock = {
  id: string
  categoryId: string
  title: string
  language: string
  code: string
  createdAt: string
  updatedAt: string
}
