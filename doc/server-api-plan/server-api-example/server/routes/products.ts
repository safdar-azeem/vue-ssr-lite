import { defineServerRoutes } from 'vue-ssr-lite'
import {
  db,
  type CreateProductInput,
  type UpdateProductInput,
} from '../db'
import { adminMiddleware } from '../middleware/admin'
import { authMiddleware } from '../middleware/auth'
import { productMiddleware } from '../middleware/product'

const isCreateProductInput = (
  value: unknown,
): value is CreateProductInput => {
  if (
    !value ||
    typeof value !== 'object'
  ) {
    return false
  }

  const input = value as Record<
    string,
    unknown
  >

  return (
    typeof input.title ===
      'string' &&
    input.title.trim() !== '' &&
    typeof input.price ===
      'number' &&
    Number.isFinite(input.price)
  )
}

const isUpdateProductInput = (
  value: unknown,
): value is UpdateProductInput => {
  if (
    !value ||
    typeof value !== 'object'
  ) {
    return false
  }

  const input = value as Record<
    string,
    unknown
  >

  if (
    input.title === undefined &&
    input.price === undefined
  ) {
    return false
  }

  if (
    input.title !== undefined &&
    (
      typeof input.title !==
        'string' ||
      input.title.trim() === ''
    )
  ) {
    return false
  }

  if (
    input.price !== undefined &&
    (
      typeof input.price !==
        'number' ||
      !Number.isFinite(input.price)
    )
  ) {
    return false
  }

  return true
}

export const productsRoutes =
  defineServerRoutes({
    prefix: '/api/products',

    middleware: [
      authMiddleware,
    ],

    routes: {
      '/': {
        async GET(
          request,
          context,
        ) {
          const url = new URL(
            request.url,
          )

          const search =
            url.searchParams.get(
              'search',
            )

          const products =
            await db.products.list()

          const filtered = search
            ? products.filter(
                (product) =>
                  product.title
                    .toLowerCase()
                    .includes(
                      search.toLowerCase(),
                    ),
              )
            : products

          return Response.json({
            products: filtered,
            user: context.user,
          })
        },

        async POST(request) {
          let input: unknown

          try {
            input =
              await request.json()
          } catch {
            return Response.json(
              {
                error:
                  'Request body must be valid JSON.',
              },
              {
                status: 400,
              },
            )
          }

          if (
            !isCreateProductInput(
              input,
            )
          ) {
            return Response.json(
              {
                error:
                  'title and price are required.',
              },
              {
                status: 400,
              },
            )
          }

          const product =
            await db.products.create({
              title:
                input.title.trim(),
              price: input.price,
            })

          return Response.json(
            {
              product,
            },
            {
              status: 201,
            },
          )
        },
      },

      '/:id': {
        middleware: [
          productMiddleware,
        ],

        GET(
          _request,
          context,
        ) {
          return Response.json({
            product:
              context.product,
          })
        },

        async PATCH(
          request,
          context,
        ) {
          let input: unknown

          try {
            input =
              await request.json()
          } catch {
            return Response.json(
              {
                error:
                  'Request body must be valid JSON.',
              },
              {
                status: 400,
              },
            )
          }

          if (
            !isUpdateProductInput(
              input,
            )
          ) {
            return Response.json(
              {
                error:
                  'Provide a valid title or price.',
              },
              {
                status: 400,
              },
            )
          }

          const product =
            await db.products.update(
              context.product.id,
              {
                title:
                  input.title?.trim(),
                price: input.price,
              },
            )

          return Response.json({
            product,
          })
        },

        DELETE: {
          middleware: [
            adminMiddleware,
          ],

          async handler(
            _request,
            context,
          ) {
            await db.products.delete(
              context.product.id,
            )

            return Response.json({
              deleted: true,
              id: context.product.id,
              deletedBy:
                context.user.name,
              isAdmin:
                context.isAdmin,
            })
          },
        },
      },
    },
  })
