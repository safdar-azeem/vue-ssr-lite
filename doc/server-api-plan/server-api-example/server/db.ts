export interface Product {
  id: number
  title: string
  price: number
}

export interface CreateProductInput {
  title: string
  price: number
}

export interface UpdateProductInput {
  title?: string
  price?: number
}

const products: Product[] = [
  {
    id: 1,
    title: 'Notebook',
    price: 8,
  },
  {
    id: 2,
    title: 'Coffee mug',
    price: 14,
  },
]

export const db = {
  products: {
    async list(): Promise<Product[]> {
      return products.map((product) => ({
        ...product,
      }))
    },

    async find(id: string): Promise<Product | null> {
      const product = products.find(
        (item) => item.id === Number(id),
      )

      return product ? { ...product } : null
    },

    async create(
      input: CreateProductInput,
    ): Promise<Product> {
      const product: Product = {
        id:
          Math.max(
            0,
            ...products.map((item) => item.id),
          ) + 1,
        title: input.title,
        price: input.price,
      }

      products.push(product)

      return { ...product }
    },

    async update(
      id: number,
      input: UpdateProductInput,
    ): Promise<Product | null> {
      const product = products.find(
        (item) => item.id === id,
      )

      if (!product) {
        return null
      }

      if (input.title !== undefined) {
        product.title = input.title
      }

      if (input.price !== undefined) {
        product.price = input.price
      }

      return { ...product }
    },

    async delete(id: number): Promise<boolean> {
      const index = products.findIndex(
        (item) => item.id === id,
      )

      if (index === -1) {
        return false
      }

      products.splice(index, 1)

      return true
    },
  },
}
