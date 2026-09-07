import type { Organization, Product } from '../shared/api'

export interface CreateProductInput {
  title: string
  description: string
  price: number
}

export interface UpdateProductInput {
  title?: string
  description?: string
  price?: number
}

const products: Product[] = [
  {
    id: 1,
    title: 'Pocket notebook',
    description: 'A compact notebook for everyday ideas.',
    price: 8,
  },
  {
    id: 2,
    title: 'Ceramic mug',
    description: 'A simple mug for coffee, tea, or water.',
    price: 14,
  },
  {
    id: 3,
    title: 'Reading lamp',
    description: 'An adjustable desk lamp with warm light.',
    price: 32,
  },
]

const organizations: Organization[] = [
  { id: 'org_1', name: 'Example Store' },
  { id: 'org_2', name: 'Example Labs' },
]

const copyProduct = (product: Product): Product => ({ ...product })
const copyOrganization = (organization: Organization): Organization => ({ ...organization })

export const db = {
  products: {
    async list(): Promise<Product[]> {
      return products.map(copyProduct)
    },

    async find(id: string | number): Promise<Product | null> {
      const product = products.find((item) => item.id === Number(id))
      return product ? copyProduct(product) : null
    },

    async create(input: CreateProductInput): Promise<Product> {
      const product: Product = {
        id: Math.max(0, ...products.map((item) => item.id)) + 1,
        title: input.title,
        description: input.description,
        price: input.price,
      }

      products.push(product)
      return copyProduct(product)
    },

    async update(id: number, input: UpdateProductInput): Promise<Product | null> {
      const product = products.find((item) => item.id === id)

      if (!product) {
        return null
      }

      if (input.title !== undefined) product.title = input.title
      if (input.description !== undefined) product.description = input.description
      if (input.price !== undefined) product.price = input.price

      return copyProduct(product)
    },

    async delete(id: number): Promise<boolean> {
      const index = products.findIndex((item) => item.id === id)

      if (index === -1) {
        return false
      }

      products.splice(index, 1)
      return true
    },
  },

  organizations: {
    async find(id: string): Promise<Organization | null> {
      const organization = organizations.find((item) => item.id === id)
      return organization ? copyOrganization(organization) : null
    },
  },
}
