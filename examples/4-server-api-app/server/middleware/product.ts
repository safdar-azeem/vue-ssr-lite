import { defineServerMiddleware } from 'vue-ssr-lite'
import { db } from '../db'
import type { Product } from '../../shared/api'
import type { AuthenticatedUser } from './auth'

export const productMiddleware = defineServerMiddleware<
  { product: Product },
  {
    user: AuthenticatedUser
    params: { id: string }
  }
>(async (_request, context, next) => {
  const product = await db.products.find(context.params.id)

  if (!product) {
    return Response.json({ error: 'Product not found.' }, { status: 404 })
  }

  context.product = product
  return next()
})
