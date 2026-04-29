/**
 * OpenAPI 3.0 document for Hallha API + Better Auth routes used by the SPA.
 * Server URL comes from BETTER_AUTH_URL at runtime.
 */
export function buildOpenApiSpec(serverBaseUrl: string): Record<string, unknown> {
  const url = serverBaseUrl.replace(/\/$/, '');

  return {
    openapi: '3.0.3',
    info: {
      title: 'Hallha API',
      description: [
        'Sharia compliance auditor API (Express + Better Auth + LangGraph).',
        '',
        '**Auth**',
        '- Sign up or sign in with JSON; copy the `Set-Cookie` header (e.g. `hallha.session_token=...`).',
        '- In **Authorize**, paste only the **cookie value** (the part after `hallha.session_token=`).',
        '- For `/api/auth/*` requests from Swagger “Try it out”, also send **Origin** matching `AUTH_TRUSTED_ORIGINS` (e.g. `http://localhost:3000`) if your server enforces it.',
        '',
        '**Thread IDs**',
        '- You send a client `thread_id`; the server namespaces it per organization for LangGraph checkpoints.',
        '',
        '**Plans**',
        '- `/chat-audit`: audit quota and PDF page limits apply.',
        '- `/upload-knowledge`: Business or Enterprise only (402 otherwise).',
        '',
        '**Specs**',
        '- Machine-readable OpenAPI: `GET /openapi.json` (same host).',
      ].join('\n'),
      version: '0.1.0',
      contact: { name: 'Hallha' },
    },
    servers: [{ url, description: 'Current server (from BETTER_AUTH_URL)' }],
    tags: [
      { name: 'System', description: 'Health and OpenAPI' },
      { name: 'Auth', description: 'Better Auth (email/password, session, organizations)' },
      { name: 'Chat audit', description: 'RAG + LLM Sharia audit' },
      { name: 'Knowledge', description: 'Custom PDF ingest to Pinecone' },
    ],
    components: {
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'hallha.session_token',
          description:
            'Session cookie set by `/api/auth/sign-up/email` or `/api/auth/sign-in/email`. In Swagger Authorize, paste the **raw token value** only.',
        },
        trustedOrigin: {
          type: 'apiKey',
          in: 'header',
          name: 'Origin',
          description:
            'Must match an entry in `AUTH_TRUSTED_ORIGINS` when the server checks origin (typical: `http://localhost:3000`).',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            detail: { type: 'string', description: 'Human-readable error' },
          },
          required: ['detail'],
        },
        Health: {
          type: 'object',
          properties: { status: { type: 'string', example: 'ok' } },
          required: ['status'],
        },
        SignUpEmailRequest: {
          type: 'object',
          required: ['email', 'password', 'name'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 8 },
            name: { type: 'string' },
            image: { type: 'string', nullable: true },
            callbackURL: { type: 'string', nullable: true },
          },
        },
        SignInEmailRequest: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string' },
            rememberMe: { type: 'boolean', default: true },
          },
        },
        SignUpResponse: {
          type: 'object',
          properties: {
            token: { type: 'string', nullable: true },
            user: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                email: { type: 'string' },
                name: { type: 'string' },
                emailVerified: { type: 'boolean' },
              },
            },
          },
        },
        SessionResponse: {
          type: 'object',
          description: 'Shape varies; includes session + user when authenticated.',
          additionalProperties: true,
        },
        ChatAuditResponse: {
          type: 'object',
          properties: {
            response: { type: 'string', description: 'Assistant / audit text' },
            thread_id: { type: 'string', description: 'Client thread id (echoed, not namespaced)' },
          },
          required: ['response', 'thread_id'],
        },
        UploadKnowledgeResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'success' },
            message: { type: 'string' },
          },
          required: ['status', 'message'],
        },
      },
    },
    paths: {
      '/health': {
        get: {
          tags: ['System'],
          summary: 'Health check',
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Health' } } },
            },
          },
        },
      },
      '/api/auth/sign-up/email': {
        post: {
          tags: ['Auth'],
          summary: 'Register with email and password',
          description:
            'Creates a user, session cookie, and a default organization (Better Auth + organization plugin).',
          parameters: [
            {
              name: 'Origin',
              in: 'header',
              schema: { type: 'string', example: 'http://localhost:3000' },
              description: 'Should match `AUTH_TRUSTED_ORIGINS` when enforced.',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SignUpEmailRequest' } },
            },
          },
          responses: {
            '200': {
              description: 'User created; `Set-Cookie: hallha.session_token=...`',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/SignUpResponse' } },
              },
            },
            '422': {
              description: 'Validation or user exists',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
          },
        },
      },
      '/api/auth/sign-in/email': {
        post: {
          tags: ['Auth'],
          summary: 'Sign in with email and password',
          parameters: [
            {
              name: 'Origin',
              in: 'header',
              schema: { type: 'string', example: 'http://localhost:3000' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SignInEmailRequest' } },
            },
          },
          responses: {
            '200': {
              description: 'Success; session cookie set',
              content: {
                'application/json': {
                  schema: { type: 'object', additionalProperties: true },
                },
              },
            },
            '401': {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
              description: 'Invalid credentials',
            },
          },
        },
      },
      '/api/auth/sign-out': {
        post: {
          tags: ['Auth'],
          summary: 'Sign out (invalidate session cookie)',
          security: [{ sessionCookie: [] }],
          parameters: [
            {
              name: 'Origin',
              in: 'header',
              schema: { type: 'string', example: 'http://localhost:3000' },
            },
          ],
          responses: {
            '200': {
              description: 'Signed out',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { success: { type: 'boolean' } },
                  },
                },
              },
            },
          },
        },
      },
      '/api/auth/get-session': {
        get: {
          tags: ['Auth'],
          summary: 'Get current session',
          security: [{ sessionCookie: [] }],
          parameters: [
            {
              name: 'Origin',
              in: 'header',
              schema: { type: 'string', example: 'http://localhost:3000' },
            },
          ],
          responses: {
            '200': {
              description: 'Session payload (or empty if not logged in)',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/SessionResponse' } },
              },
            },
          },
        },
      },
      '/api/auth/organization/list': {
        get: {
          tags: ['Auth'],
          summary: 'List organizations for the current user',
          security: [{ sessionCookie: [] }, { trustedOrigin: [] }],
          parameters: [
            {
              name: 'Origin',
              in: 'header',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'Array of organizations',
              content: {
                'application/json': {
                  schema: { type: 'array', items: { type: 'object', additionalProperties: true } },
                },
              },
            },
            '401': {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
              description: 'Unauthorized',
            },
          },
        },
      },
      '/api/auth/organization/set-active': {
        post: {
          tags: ['Auth'],
          summary: 'Set active organization on the session',
          security: [{ sessionCookie: [] }, { trustedOrigin: [] }],
          parameters: [
            {
              name: 'Origin',
              in: 'header',
              required: true,
              schema: { type: 'string' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    organizationId: { type: 'string', nullable: true },
                    organizationSlug: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Updated' },
            '401': {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
              description: 'Unauthorized',
            },
          },
        },
      },
      '/chat-audit': {
        post: {
          tags: ['Chat audit'],
          summary: 'Run Sharia audit (optional PDF/text file)',
          description:
            'Multipart form. Requires session. Consumes audit quota; PDFs are capped by plan page limit.',
          security: [{ sessionCookie: [] }, { trustedOrigin: [] }],
          parameters: [
            {
              name: 'Origin',
              in: 'header',
              required: true,
              schema: { type: 'string', example: 'http://localhost:3000' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['thread_id'],
                  properties: {
                    thread_id: {
                      type: 'string',
                      description: 'Client-visible conversation id (namespaced server-side)',
                    },
                    message: {
                      type: 'string',
                      description: 'User message; defaults to audit instruction if omitted',
                    },
                    file: {
                      type: 'string',
                      format: 'binary',
                      description: 'Optional .pdf or text file',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Audit result',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/ChatAuditResponse' } },
              },
            },
            '401': {
              description: 'Not authenticated',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
            '402': {
              description: 'Quota or plan limit',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
            '422': {
              description: 'Missing thread_id',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
            '429': {
              description: 'Groq rate limit / quota',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
            '502': {
              description: 'Upstream LLM error',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
          },
        },
      },
      '/upload-knowledge': {
        post: {
          tags: ['Knowledge'],
          summary: 'Upload a PDF to the org knowledge base (Pinecone)',
          description: 'Business or Enterprise plan only. Multipart with single PDF field `file`.',
          security: [{ sessionCookie: [] }, { trustedOrigin: [] }],
          parameters: [
            {
              name: 'Origin',
              in: 'header',
              required: true,
              schema: { type: 'string', example: 'http://localhost:3000' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['file'],
                  properties: {
                    file: { type: 'string', format: 'binary', description: 'PDF document' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Ingest started/completed',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/UploadKnowledgeResponse' },
                },
              },
            },
            '400': {
              description: 'Bad file / ingest error',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
            '401': {
              description: 'Not authenticated',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
            '402': {
              description: 'Plan does not allow custom KB',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
          },
        },
      },
    },
  };
}
