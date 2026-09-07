import { defineServerRoutes } from 'vue-ssr-lite'
import { db, type CreateProductInput, type UpdateProductInput } from '../db'
import { adminMiddleware } from '../middleware/admin'
import { authMiddleware } from '../middleware/auth'
import { productMiddleware } from '../middleware/product'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const isCreateProductInput = (value: unknown): value is CreateProductInput => {
  if (!isRecord(value)) return false

  return (
    typeof value.title === 'string' &&
    value.title.trim() !== '' &&
    typeof value.description === 'string' &&
    value.description.trim() !== '' &&
    typeof value.price === 'number' &&
    Number.isFinite(value.price) &&
    value.price >= 0
  )
}

const isUpdateProductInput = (value: unknown): value is UpdateProductInput => {
  if (!isRecord(value)) return false

  if (
    value.title === undefined &&
    value.description === undefined &&
    value.price === undefined
  ) {
    return false
  }

  if (
    value.title !== undefined &&
    (typeof value.title !== 'string' || value.title.trim() === '')
  ) {
    return false
  }

  if (
    value.description !== undefined &&
    (typeof value.description !== 'string' || value.description.trim() === '')
  ) {
    return false
  }

  if (
    value.price !== undefined &&
    (typeof value.price !== 'number' || !Number.isFinite(value.price) || value.price < 0)
  ) {
    return false
  }

  return true
}

export const productsRoutes = defineServerRoutes({
  prefix: '/api/products',

  // Group middleware: runs for every supported method in this route group.
  middleware: [
    authMiddleware,
  ],

  routes: {
    '/': {
      async GET(request, context) {
        const url = new URL(request.url)
        const search = url.searchParams.get('search')
        const products = await db.products.list()

        const filtered = search
          ? products.filter((product) =>
              product.title.toLowerCase().includes(search.toLowerCase()),
            )
          : products

        return Response.json(
          {
            products: filtered,
            viewer: context.user,
            search,
          },
          {
            headers: {
              'cache-control': 'no-store',
            },
          },
        )
      },

      async POST(request, context) {
        let input: unknown

        try {
          input = await request.json()
        } catch {
          return Response.json(
            { error: 'Request body must be valid JSON.' },
            { status: 400 },
          )
        }

        if (!isCreateProductInput(input)) {
          return Response.json(
            { error: 'title, description, and a non-negative price are required.' },
            { status: 400 },
          )
        }

        const product = await db.products.create({
          title: input.title.trim(),
          description: input.description.trim(),
          price: input.price,
        })

        return Response.json(
          {
            product,
            createdBy: context.user.name,
          },
          { status: 201 },
        )
      },
    },

    '/:id': {
      // Path middleware: has access to params.id and context.user.
      middleware: [
        productMiddleware,
      ],

      GET(_request, context) {
        return Response.json({
          product: context.product,
        })
      },

      async PATCH(request, context) {
        let input: unknown

        try {
          input = await request.json()
        } catch {
          return Response.json(
            { error: 'Request body must be valid JSON.' },
            { status: 400 },
          )
        }

        if (!isUpdateProductInput(input)) {
          return Response.json(
            { error: 'Provide at least one valid title, description, or price.' },
            { status: 400 },
          )
        }

        const product = await db.products.update(context.product.id, {
          title: input.title?.trim(),
          description: input.description?.trim(),
          price: input.price,
        })

        if (!product) {
          return Response.json({ error: 'Product not found.' }, { status: 404 })
        }

        return Response.json({
          product,
          updatedBy: context.user.name,
        })
      },

      DELETE: {
        // Method middleware: only DELETE requires admin privileges.
        middleware: [
          adminMiddleware,
        ],

        async handler(_request, context) {
          const deleted = await db.products.delete(context.product.id)

          if (!deleted) {
            return Response.json({ error: 'Product not found.' }, { status: 404 })
          }

          return Response.json({
            deleted: true,
            id: context.product.id,
            deletedBy: context.user.name,
            isAdmin: context.isAdmin,
          })
        },
      },
    },
  },
})
