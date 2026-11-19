export function openapiSpec() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'HYDRA key rotator',
      version: '1.0.0',
      description:
        'OpenAI-compatible and Anthropic-compatible gateway that spreads traffic across a pool of upstream API keys.'
    },
    servers: [{ url: 'http://localhost:8080' }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'Any access key created in the panel' },
        apiKeyAuth: { type: 'apiKey', in: 'header', name: 'x-api-key' }
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: { message: { type: 'string' }, type: { type: 'string' }, code: { type: 'integer' } }
            }
          }
        },
        ChatCompletionRequest: {
          type: 'object',
          required: ['model', 'messages'],
          properties: {
            model: { type: 'string' },
            messages: {
              type: 'array',
              items: {
                type: 'object',
                required: ['role', 'content'],
                properties: { role: { type: 'string' }, content: { type: ['string', 'array'] } }
              }
            },
            stream: { type: 'boolean' },
            temperature: { type: 'number' },
            max_tokens: { type: 'integer' },
            tools: { type: 'array', items: { type: 'object' } }
          }
        }
      }
    },
    paths: {
      '/v1/chat/completions': {
        post: {
          summary: 'OpenAI chat completions',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatCompletionRequest' } } }
          },
          responses: {
            200: { description: 'Completion or SSE stream' },
            429: { description: 'Access key limit or pool saturated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            502: { description: 'Every upstream attempt failed' },
            503: { description: 'No upstream key available' }
          }
        }
      },
      '/v1/messages': {
        post: {
          summary: 'Anthropic messages',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['model', 'messages'],
                  properties: {
                    model: { type: 'string' },
                    messages: { type: 'array', items: { type: 'object' } },
                    max_tokens: { type: 'integer' },
                    system: { type: ['string', 'array'] },
                    stream: { type: 'boolean' }
                  }
                }
              }
            }
          },
          responses: { 200: { description: 'Message or SSE stream' } }
        }
      },
      '/v1/models': {
        get: { summary: 'List advertised models', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Model list' } } }
      },
      '/metrics': {
        get: { summary: 'Prometheus metrics', security: [], responses: { 200: { description: 'Prometheus text format' } } }
      },
      '/healthz': {
        get: { summary: 'Liveness probe', security: [], responses: { 200: { description: 'Key count and uptime' } } }
      }
    }
  };
}