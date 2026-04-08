# Evidence

- Official OpenAI docs confirm streamed function calling emits `response.output_item.added`, `response.function_call_arguments.delta`, and `response.function_call_arguments.done`, and that clients must aggregate function-call data from events.
- Local test pass:
  - `npm test -- --run tests/unit/native-responses.test.ts`
  - `npm run typecheck`
  - `npm run build:server`
- Production deploy:
  - synced updated `dist/` to `158.160.220.215:/opt/eveai/dist/`
  - restarted `eveai-backend.service`
- Live verification:
  - direct server-side invocation of `createNativeResponse()` logged `[calls] echo_city`, proving streamed function calls are now recognized by the production parser.
