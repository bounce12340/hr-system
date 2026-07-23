import { handleApi } from "../../src/server/router";

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  return handleApi(request, env);
};
