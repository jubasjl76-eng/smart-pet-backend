import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { User } from '../models/index.js';
import { auth, generateToken, AuthRequest } from '../middleware/auth.js';

const router = Router();

// Validation middleware
const validate = (req: Request, res: Response, next: Function): void => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return;
  }
  next();
};

// POST /api/auth/register - Register new user
router.post('/register', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('name').trim().notEmpty(),
], validate, async (req: Request, res: Response) => {
  try {
    const { email, password, name } = req.body;
    
    // Check if user exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      res.status(400).json({ error: 'Email already registered' });
      return;
    }
    
    // Create user
    const user = new User({ email, password, name });
    await user.save();
    
    // Generate token
    const token = generateToken(user._id.toString());
    
    res.status(201).json({
      message: 'User registered successfully',
      user: user.toJSON(),
      token,
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login - Login user
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], validate, async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    
    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    
    // Check password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    
    // Generate token
    const token = generateToken(user._id.toString());
    
    res.json({
      message: 'Login successful',
      user: user.toJSON(),
      token,
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/me - Get current user
router.get('/me', auth, async (req: AuthRequest, res: Response) => {
  res.json({ user: req.user?.toJSON() });
});

// PUT /api/auth/profile - Update profile
router.put('/profile', auth, [
  body('name').optional().trim().notEmpty(),
  body('email').optional().isEmail().normalizeEmail(),
], validate, async (req: AuthRequest, res: Response) => {
  try {
    const { name, email } = req.body;
    const user = req.user;
    
    if (name) user!.name = name;
    if (email) {
      // Check if email is taken
      const existing = await User.findOne({ email });
      if (existing && existing._id.toString() !== user!._id.toString()) {
        res.status(400).json({ error: 'Email already in use' });
        return;
      }
      user!.email = email;
    }
    
    await user!.save();
    
    res.json({ user: user!.toJSON() });
  } catch (error) {
    res.status(500).json({ error: 'Update failed' });
  }
});

// PUT /api/auth/password - Change password
router.put('/password', auth, [
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 6 }),
], validate, async (req: AuthRequest, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = req.user;
    
    // Verify current password
    const isMatch = await user!.comparePassword(currentPassword);
    if (!isMatch) {
      res.status(401).json({ error: 'Current password is incorrect' });
      return;
    }
    
    user!.password = newPassword;
    await user!.save();
    
    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Password update failed' });
  }
});

export default router;
