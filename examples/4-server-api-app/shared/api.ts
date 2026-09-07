export interface ApiUser {
  id: string
  name: string
  role: 'admin' | 'member'
}

export interface Product {
  id: number
  title: string
  description: string
  price: number
}

export interface Organization {
  id: string
  name: string
}

export interface HealthResponse {
  status: 'ok'
  requestId: string
}

export interface ProductsResponse {
  products: Product[]
  viewer: ApiUser
  search: string | null
}

export interface ProductResponse {
  product: Product
}

export interface OrganizationProductResponse {
  organization: Organization
  product: Product
  viewer: ApiUser
}
