import { Router } from 'express';
import { z } from '@jubasjl76-eng/shared';
import * as authController from '../controllers/authController.js';
import { auth } from '../middleware/auth.js';
import { apiRoute } from '../openapi/index.js';

const router = Router();
const T = ['auth'];

const email = z.string().trim().toLowerCase().pipe(z.string().email());
const password = z.string().min(6);

const userShape = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable().optional(),
  role: z.string(),
  kennelId: z.string().nullable().optional(),
});
const authOk = z.object({ message: z.string(), user: userShape, token: z.string() });

// POST /api/auth/register
router.post(
  '/register',
  apiRoute({
    method: 'post',
    path: '/api/auth/register',
    tags: T,
    summary: 'Create the first owner account (or a self-serve owner).',
    request: { body: z.object({ email, password, name: z.string().trim().min(1) }) },
    responses: {
      201: { description: 'created', schema: authOk },
      409: { description: 'email taken' },
    },
  }),
  authController.register,
);

// POST /api/auth/login
router.post(
  '/login',
  apiRoute({
    method: 'post',
    path: '/api/auth/login',
    tags: T,
    summary: 'Exchange email + password for an access token + a rotating refresh token.',
    request: { body: z.object({ email, password: z.string().min(1) }) },
    responses: {
      200: { description: 'ok', schema: authOk },
      401: { description: 'bad credentials' },
    },
  }),
  authController.login,
);

// POST /api/auth/refresh
router.post(
  '/refresh',
  apiRoute({
    method: 'post',
    path: '/api/auth/refresh',
    tags: T,
    summary: 'Rotate a refresh token; returns a new access + refresh pair.',
    request: { body: z.object({ refreshToken: z.string().min(1) }) },
    responses: {
      200: { description: 'ok', schema: authOk },
      401: { description: 'invalid / reused token' },
    },
  }),
  authController.refresh,
);

// POST /api/auth/logout
router.post(
  '/logout',
  apiRoute({
    method: 'post',
    path: '/api/auth/logout',
    tags: T,
    summary: 'Revoke the given refresh token (or all of the caller’s).',
    request: {
      body: z.object({ refreshToken: z.string().optional(), all: z.boolean().optional() }),
    },
    responses: { 200: { description: 'revoked' } },
  }),
  authController.logout,
);

// POST /api/auth/accept-invite
router.post(
  '/accept-invite',
  apiRoute({
    method: 'post',
    path: '/api/auth/accept-invite',
    tags: T,
    summary: 'Turn a staff/owner invite token into an account.',
    request: {
      body: z.object({
        token: z.string().min(1),
        name: z.string().trim().min(1).optional(),
        password,
      }),
    },
    responses: {
      201: { description: 'created', schema: authOk },
      400: { description: 'bad / expired token' },
    },
  }),
  authController.acceptInvite,
);

// GET /api/auth/me
router.get(
  '/me',
  auth,
  apiRoute({
    method: 'get',
    path: '/api/auth/me',
    tags: T,
    secure: true,
    summary: 'The current user.',
    responses: {
      200: { description: 'ok', schema: userShape },
      401: { description: 'unauthenticated' },
    },
  }),
  authController.getMe,
);

// PUT /api/auth/profile
router.put(
  '/profile',
  auth,
  apiRoute({
    method: 'put',
    path: '/api/auth/profile',
    tags: T,
    secure: true,
    summary: 'Update the current user’s name / email.',
    request: {
      body: z.object({ name: z.string().trim().min(1).optional(), email: email.optional() }),
    },
    responses: { 200: { description: 'ok', schema: userShape } },
  }),
  authController.updateProfile,
);

// PUT /api/auth/password
router.put(
  '/password',
  auth,
  apiRoute({
    method: 'put',
    path: '/api/auth/password',
    tags: T,
    secure: true,
    summary: 'Change the current user’s password.',
    request: { body: z.object({ currentPassword: z.string().min(1), newPassword: password }) },
    responses: { 200: { description: 'changed' }, 401: { description: 'wrong current password' } },
  }),
  authController.changePassword,
);

export default router;
