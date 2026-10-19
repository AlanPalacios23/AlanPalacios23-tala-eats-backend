import Stripe from 'stripe';
import { config } from './config.js';
// Únicamente clave test; no hay endpoints de creación de cobros o retiros.
export const stripe = config.STRIPE_SECRET_KEY
  ? new Stripe(config.STRIPE_SECRET_KEY, { maxNetworkRetries: 0 })
  : undefined;
