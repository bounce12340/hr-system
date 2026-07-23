import { handleApi } from "../src/server/router";

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleApi(request, env);
  },
} satisfies ExportedHandler<Env>;
