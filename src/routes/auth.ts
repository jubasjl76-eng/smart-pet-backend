import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import * as authController from '../controllers/authController.js';
import { auth } from '../middleware/auth.js';

const router = Router();

const validate = (req: Request, res: Response, next: Function): void => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return;
  }
  next();
};

router.post('/register', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('name').trim().notEmpty(),
], validate, authController.register);

router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], validate, authController.login);

router.get('/me', auth, authController.getMe);

router.put('/profile', auth, [
  body('name').optional().trim().notEmpty(),
  body('email').optional().isEmail().normalizeEmail(),
], validate, authController.updateProfile);

router.put('/password', auth, [
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 6 }),
], validate, authController.changePassword);

export default router;
