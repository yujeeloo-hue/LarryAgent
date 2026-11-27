#ifndef JELLYBOT_NODE_API_SHIM_H
#define JELLYBOT_NODE_API_SHIM_H

#include <stddef.h>
#include <stdint.h>

#define NAPI_AUTO_LENGTH SIZE_MAX
#define NAPI_CDECL

typedef enum {
  napi_ok = 0,
  napi_failed = 1
} napi_status;

typedef struct napi_env__* napi_env;
typedef struct napi_value__* napi_value;
typedef struct napi_deferred__* napi_deferred;
typedef struct napi_async_work__* napi_async_work;
typedef struct napi_callback_info__* napi_callback_info;

typedef napi_value(NAPI_CDECL* napi_callback)(napi_env, napi_callback_info);
typedef void(NAPI_CDECL* napi_async_execute_callback)(napi_env, void*);
typedef void(NAPI_CDECL* napi_async_complete_callback)(napi_env, napi_status, void*);

napi_status napi_get_cb_info(napi_env, napi_callback_info, size_t*, napi_value*, napi_value*, void**);
napi_status napi_get_value_string_utf8(napi_env, napi_value, char*, size_t, size_t*);
napi_status napi_create_string_utf8(napi_env, const char*, size_t, napi_value*);
napi_status napi_create_function(napi_env, const char*, size_t, napi_callback, void*, napi_value*);
napi_status napi_set_named_property(napi_env, napi_value, const char*, napi_value);
napi_status napi_create_promise(napi_env, napi_deferred*, napi_value*);
napi_status napi_resolve_deferred(napi_env, napi_deferred, napi_value);
napi_status napi_reject_deferred(napi_env, napi_deferred, napi_value);
napi_status napi_create_error(napi_env, napi_value, napi_value, napi_value*);
napi_status napi_create_async_work(napi_env, napi_value, napi_value, napi_async_execute_callback, napi_async_complete_callback, void*, napi_async_work*);
napi_status napi_queue_async_work(napi_env, napi_async_work);
napi_status napi_delete_async_work(napi_env, napi_async_work);

#define NAPI_MODULE(modname, regfunc) \
  napi_value napi_register_module_v1(napi_env env, napi_value exports) { return regfunc(env, exports); }

#endif
