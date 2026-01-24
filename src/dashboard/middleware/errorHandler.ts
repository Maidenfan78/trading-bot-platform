/* eslint-disable no-console */
import type { Request, Response, NextFunction } from 'express';

/**
 * Create global error handling middleware
 */
export function createErrorHandler(isDevelopment: boolean) {
  return function errorHandler(
    err: Error & { statusCode?: number; status?: number },
    req: Request,
    res: Response,
    _next: NextFunction
  ): void {
    // Log error
    console.error('=== Error Handler ===');
    console.error('Path:', req.path);
    console.error('Method:', req.method);
    console.error('Error:', err);
    console.error('Stack:', err.stack);
    console.error('====================');

    // Determine status code
    const statusCode = err.statusCode || err.status || 500;

    // Prepare error response
    const errorResponse: Record<string, unknown> = {
      error: err.message || 'Internal server error',
      path: req.path,
      method: req.method,
      timestamp: new Date().toISOString(),
    };

    // Include stack trace in development
    if (isDevelopment) {
      errorResponse.stack = err.stack;
    }

    // Send error response
    res.status(statusCode).json(errorResponse);
  };
}

/**
 * 404 Not Found handler
 */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: 'Endpoint not found',
    path: req.path,
    method: req.method,
    availableEndpoints: [
      'GET /api/health',
      'GET /api/bots',
      'GET /api/status',
      'GET /api/positions/:bot',
      'GET /api/trades/:bot',
      'GET /api/performance/:bot',
      'GET /api/logs/:bot',
      'POST /api/auth/login',
      'POST /api/control/:bot/:action',
    ],
  });
}

/**
 * Async handler wrapper to catch errors in async route handlers
 */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
