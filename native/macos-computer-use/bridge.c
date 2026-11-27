#include "node_api_shim.h"
#include <stdlib.h>

extern char *jb_computer_use_dispatch(const char *request);

typedef struct {
  napi_deferred deferred;
  napi_async_work work;
  char *request;
  char *response;
} request_data;

static void execute(napi_env env, void *data) {
  request_data *d = (request_data *)data;
  d->response = jb_computer_use_dispatch(d->request);
}

static void complete(napi_env env, napi_status status, void *data) {
  request_data *d = (request_data *)data;
  if (d->response == NULL) {
    napi_value message;
    napi_create_string_utf8(env, "Computer use helper returned no response.", NAPI_AUTO_LENGTH, &message);
    napi_value error;
    napi_create_error(env, NULL, message, &error);
    napi_reject_deferred(env, d->deferred, error);
  } else {
    napi_value result;
    napi_create_string_utf8(env, d->response, NAPI_AUTO_LENGTH, &result);
    napi_resolve_deferred(env, d->deferred, result);
    free(d->response);
  }
  napi_delete_async_work(env, d->work);
  free(d->request);
  free(d);
}

static napi_value dispatch(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  size_t length = 0;
  napi_get_value_string_utf8(env, args[0], NULL, 0, &length);
  char *request = malloc(length + 1);
  napi_get_value_string_utf8(env, args[0], request, length + 1, &length);

  napi_value promise;
  napi_deferred deferred;
  napi_create_promise(env, &deferred, &promise);
  request_data *data = malloc(sizeof(request_data));
  data->deferred = deferred;
  data->request = request;
  data->response = NULL;
  napi_value name;
  napi_create_string_utf8(env, "jellybot_computer_use", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(env, NULL, name, execute, complete, data, &data->work);
  napi_queue_async_work(env, data->work);
  return promise;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "dispatch", NAPI_AUTO_LENGTH, dispatch, NULL, &fn);
  napi_set_named_property(env, exports, "dispatch", fn);
  return exports;
}

NAPI_MODULE(jellybot_computer_use, init)
