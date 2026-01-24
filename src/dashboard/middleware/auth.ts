/* eslint-disable no-console */
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';

export interface JWTPayload {
  username: string;
  iat: number;
  exp: number;
}

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload;
    }
  }
}

/**
 * Create a verify token middleware with the given JWT secret
 */
export function createVerifyToken(jwtSecret: string) {
  return function verifyToken(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid authorization header' });
      return;
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    try {
      const decoded = jwt.verify(token, jwtSecret) as JWTPayload;
      req.user = decoded;
      next();
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        res.status(401).json({ error: 'Token expired' });
      } else if (error instanceof jwt.JsonWebTokenError) {
        res.status(401).json({ error: 'Invalid token' });
      } else {
        res.status(401).json({ error: 'Authentication failed' });
      }
    }
  };
}

/**
 * Create login function with the given credentials
 */
export function createLogin(jwtSecret: string, username: string, passwordHash: string) {
  return async function login(inputUsername: string, inputPassword: string): Promise<string | null> {
    // Check username
    if (inputUsername !== username) {
      console.log(`Login failed: Invalid username "${inputUsername}"`);
      return null;
    }

    // Verify password
    try {
      const match = await bcrypt.compare(inputPassword, passwordHash);
      if (!match) {
        console.log(`Login failed: Invalid password for user "${inputUsername}"`);
        return null;
      }
    } catch (error) {
      console.error('Password comparison error:', error);
      return null;
    }

    // Generate JWT token
    const token = jwt.sign(
      { username: inputUsername },
      jwtSecret,
      { expiresIn: '24h' }
    );

    console.log(`Login successful for user "${inputUsername}"`);
    return token;
  };
}

/**
 * Generate password hash (utility for setup)
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

/**
 * Rate limiting for auth endpoints
 */
const loginAttempts = new Map<string, { count: number; resetTime: number }>();

export function rateLimitLogin(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || 'unknown';
  const now = Date.now();

  // Clean up old entries (older than 15 minutes)
  for (const [key, value] of loginAttempts.entries()) {
    if (now > value.resetTime) {
      loginAttempts.delete(key);
    }
  }

  const attempts = loginAttempts.get(ip);

  if (!attempts) {
    // First attempt
    loginAttempts.set(ip, { count: 1, resetTime: now + 15 * 60 * 1000 });
    next();
    return;
  }

  if (attempts.count >= 5) {
    res.status(429).json({
      error: 'Too many login attempts. Please try again later.',
      retryAfter: Math.ceil((attempts.resetTime - now) / 1000),
    });
    return;
  }

  // Increment attempt count
  attempts.count++;
  next();
}

/**
 * Reset rate limit for successful login
 */
export function resetRateLimit(req: Request): void {
  const ip = req.ip || 'unknown';
  loginAttempts.delete(ip);
}
