/**
 * formatError — copied verbatim from @scimeto/shared during the Wave 3
 * referencecheck extraction. referencecheck never imports @scimeto/shared;
 * crossref.ts is its only consumer. Keep this byte-identical to the
 * @scimeto/shared original; do not let the two copies diverge.
 */

/**
 * Format an error into a descriptive message with all available context
 */
export function formatError(error: unknown, context?: string): string {
    // Build error message parts
    const parts: string[] = [];

    if (context) {
        parts.push(`[${context}]`);
    }

    // Handle Error objects
    if (error instanceof Error) {
        parts.push(error.message);

        // Add error name if it's not generic
        if (error.name && error.name !== 'Error') {
            parts.push(`(${error.name})`);
        }

        // Add cause if available (ES2022+ feature)
        const errorWithCause = error as any;
        if (errorWithCause.cause) {
            const causeMessage = errorWithCause.cause instanceof Error
                ? errorWithCause.cause.message
                : String(errorWithCause.cause);
            parts.push(`Caused by: ${causeMessage}`);
        }

        // Add stack trace in development and not in browser
        if (typeof process !== 'undefined' && process.env.NODE_ENV === 'development' && error.stack) {
            parts.push(`Stack: ${error.stack.split('\n').slice(0, 3).join(' -> ')}`);
        }
    }
    // Handle PostgrestError (Supabase errors)
    else if (error && typeof error === 'object' && 'message' in error) {
        const err = error as any;
        parts.push(err.message || 'Database error');

        if (err.code) {
            parts.push(`Code: ${err.code}`);
        }

        if (err.details) {
            parts.push(`Details: ${err.details}`);
        }

        if (err.hint) {
            parts.push(`Hint: ${err.hint}`);
        }
    }
    // Handle string errors
    else if (typeof error === 'string') {
        parts.push(error);
    }
    // Handle objects with message property
    else if (error && typeof error === 'object' && 'message' in error) {
        parts.push(String((error as any).message));
    }
    // Fallback for unknown types
    else {
        parts.push(`Unexpected error type: ${typeof error}`);
        if (error !== null && error !== undefined) {
            try {
                parts.push(`Value: ${JSON.stringify(error)}`);
            } catch {
                // ignore
            }
        }
    }

    return parts.join(' ').trim() || 'An unexpected error occurred';
}
