export type User = {
  username: string
  password: string
  status: 'pending' | 'approved' | 'rejected'
  enabled: boolean
  role: 'admin' | 'user'
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
