import type { Express, RequestHandler } from 'express';
import swaggerUi from 'swagger-ui-express';
import { buildOpenApiSpec } from './build-spec.js';

export function installSwagger(app: Express, serverBaseUrl: string): void {
  const spec = buildOpenApiSpec(serverBaseUrl);

  app.get('/openapi.json', (_req, res) => {
    res.json(spec);
  });

  const serve = swaggerUi.serve as RequestHandler[];
  app.use(
    '/docs',
    ...serve,
    swaggerUi.setup(spec, {
      customSiteTitle: 'Hallha API',
      customCss: '.swagger-ui .topbar { display: none }',
      swaggerOptions: {
        persistAuthorization: true,
        tryItOutEnabled: true,
        displayRequestDuration: true,
        filter: true,
        syntaxHighlight: { theme: 'obsidian' },
      },
    }),
  );
}
