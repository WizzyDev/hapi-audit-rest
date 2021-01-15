import { AUDIT_TYPE } from "./enums";
import {
  clone,
  isRead,
  isCreate,
  isUpdate,
  isDelete,
  isDisabled,
  isLoggedIn,
  getEntity,
  toEndpoint,
  isSuccessfulResponse,
  createMutation,
  createAction,
  getEntityId,
  gotResponseData,
  shouldAuditRequest,
  removeProps,
  isStream,
  getUser,
} from "./utils";
import validateSchema from "./validations";

exports.plugin = {
  requirements: {
    hapi: ">=17.0.0",
  },
  name: "hapi-audit-rest",
  version: "1.8.0",
  async register(server, options) {
    // validate options schema
    validateSchema(options);

    const FIVE_MINS_MSECS = 300000;
    const ID_PARAM_DEFAULT = "id";
    const {
      disableOnRoutes, // TODO
      auditGetRequests = true,
      showErrorsOnStdErr = true,
      diffFunc = () => [{}, {}],
      disableCache = false,
      clientId = "client-app",
      sidUsernameAttribute = "userName",
      emitEventName = "auditing",
      cacheExpiresIn = FIVE_MINS_MSECS,
      isAuditable = (path, method) => path.startsWith("/api"),
      eventHanler = (data) => {
        console.log("Emitted Audit Record", JSON.stringify(data, null, 4));
      },
    } = options;

    // initialize caches
    let oldValsCache = new Map();
    const auditValues = new Map();

    // register event
    server.event(emitEventName);

    // register event handler
    server.events.on(emitEventName, eventHanler);

    const handleError = (request, error) => {
      if (showErrorsOnStdErr) {
        console.error(`[${this.name}] =======> ERROR: ${error.message}`);
      }
      request.log(["error", "auditing-error"], error.message);
    };

    const emitAuditEvent = (rec, routeEndpoint) => {
      if (rec != null) {
        server.events.emit(emitEventName, rec);

        // clear cached data, necessary only on put
        auditValues.delete(routeEndpoint);
      } else {
        throw new Error(
          `Cannot audit null audit record for endpoint: ${routeEndpoint}`
        );
      }
    };

    const fetchValues = async ({ headers, auth, url: { pathname } }) =>
      server.inject({
        method: "GET",
        url: pathname,
        headers: { ...headers, injected: "true" },
        auth,
      });

    // ------------------------------- PRE-HANDLER ------------------------- //
    server.ext("onPreHandler", async (request, h) => {
      try {
        const { [this.name]: auditing = {} } = request.route.settings.plugins;
        // route specific auditing options
        const {
          action,
          entity,
          entityKeys,
          idParam = ID_PARAM_DEFAULT,
          getPath,
          getPathId,
          skipDiff = [],
        } = auditing;

        const username = getUser(request, sidUsernameAttribute);

        const {
          url: { pathname },
          method,
          params,
          payload,
        } = request;

        /**
         * skip audit if disabled on route
         * skip audit if not within session scope
         * skip audit if path does no match criteria
         * if this will be handled as a custom action skip to process on preResponse
         */
        if (
          isDisabled(auditing) ||
          !isLoggedIn(username) ||
          !isAuditable(pathname, method) ||
          action
        ) {
          return h.continue;
        }

        const id = params[idParam];
        const getEndpoint = toEndpoint("get", pathname, getPath);
        const routeEndpoint = toEndpoint(method, pathname);

        if (isUpdate(method)) {
          let oldVals = null;
          let newVals = null;
          let isProxy = false;

          // check if proxied to upstream server
          if (isStream(payload)) {
            isProxy = true;
          } else {
            newVals = clone(payload);
          }

          if (!disableCache) {
            oldVals = oldValsCache.get(getEndpoint);
          }

          // if null or cache undefined
          if (oldVals == null) {
            const { payload: data } = await fetchValues(request);
            oldVals = JSON.parse(data);
          } else {
            // evict key due to update
            oldValsCache.delete(getEndpoint);
          }

          if (oldVals === null) {
            throw new Error(
              `Cannot get data before update on ${routeEndpoint}`
            );
          }

          if (isProxy) {
            oldValsCache.set(getEndpoint, oldVals);
            return h.continue;
          }

          removeProps(oldVals, newVals, skipDiff);

          const [originalValues, newValues] = diffFunc(oldVals, newVals);

          const rec = createMutation({
            method,
            clientId,
            entity: getEntity(entity, pathname),
            entityId: getEntityId(entityKeys, id, newVals),
            username,
            originalValues,
            newValues,
          });

          // save to oldValsCache to emit on success
          auditValues.set(routeEndpoint, rec);
        } else if (isDelete(method)) {
          const { payload: originalValues } = await fetchValues(request);

          const rec = createMutation({
            method,
            clientId,
            entity: getEntity(entity, pathname),
            entityId: getEntityId(entityKeys, id, originalValues),
            username,
            originalValues,
          });

          // save to oldValsCache to emit on success
          auditValues.set(routeEndpoint, rec);
        }
      } catch (error) {
        handleError(request, error);
      }

      return h.continue;
    });

    // ------------------------------- PRE-RESPONSE ------------------------- //
    server.ext("onPreResponse", async (request, h) => {
      try {
        const { [this.name]: auditing = {} } = request.route.settings.plugins;
        // route specific auditing options
        const {
          action,
          entity,
          entityKeys,
          idParam = ID_PARAM_DEFAULT,
          skipDiff,
          getPath,
        } = auditing;

        const username = getUser(request, sidUsernameAttribute);

        const {
          url: { pathname },
          headers: { injected },
          method,
          query,
          params,
          payload,
          response,
        } = request;
        const { source, statusCode } = response;

        /**
         * skip audit if disabled on route
         * skip audit if not within session scope
         * skip audit if path does no match criteria
         */
        if (
          isDisabled(auditing) ||
          !isLoggedIn(username) ||
          !isAuditable(pathname, method)
        ) {
          return h.continue;
        }

        const routeEndpoint = toEndpoint(method, pathname);
        const getEndpoint = toEndpoint("get", pathname, getPath);
        let rec = null;

        /**
         * Override default behaviour. For POST, PUT if user action is specified on route
         * don't create a mutation but an action instead with the payload data
         * */
        if (
          action &&
          (isUpdate(method) || isCreate(method)) &&
          isSuccessfulResponse(statusCode)
        ) {
          const id = params[idParam] || payload[idParam];

          rec = createAction({
            clientId,
            entity: getEntity(entity, pathname),
            entityId: getEntityId(entityKeys, id, payload),
            username,
            data: payload,
            action,
            type: action,
          });
        }

        if (
          isRead(method) &&
          isSuccessfulResponse(statusCode) &&
          injected == null
        ) {
          const id = params[idParam];

          if (id && !disableCache && !isStream(source)) {
            oldValsCache.set(getEndpoint, source);
          }

          rec = createAction({
            clientId,
            entity: getEntity(entity, pathname),
            entityId: getEntityId(entityKeys, id),
            username,
            data: query,
            action: (action && action.toUpperCase()) || AUDIT_TYPE.SEARCH,
          });
        } else if (isUpdate(method) && isSuccessfulResponse(statusCode)) {
          // if proxied check cache for initial data and the response for new
          const id = params[idParam];
          const oldVals = oldValsCache.get(getEndpoint);

          if (isStream(source)) {
            const { payload: data } = await fetchValues(request);
            const newVals = JSON.parse(data);

            removeProps(oldVals, newVals, skipDiff);
            const [originalValues, newValues] = diffFunc(oldVals, newVals);

            rec = createMutation({
              method,
              clientId,
              entity: getEntity(entity, pathname),
              entityId: getEntityId(entityKeys, id, newVals),
              username,
              originalValues,
              newValues,
            });

            oldValsCache.delete(getEndpoint);
          } else {
            rec = auditValues.get(routeEndpoint);
          }
        } else if (isDelete(method) && isSuccessfulResponse(statusCode)) {
          rec = auditValues.get(routeEndpoint);
        } else if (isCreate(method) && isSuccessfulResponse(statusCode)) {
          const id = gotResponseData(source)
            ? source[idParam]
            : payload[idParam];
          const data = gotResponseData(source) ? source : payload;

          rec = createMutation({
            method,
            clientId,
            entity: getEntity(entity, pathname),
            entityId: getEntityId(entityKeys, id, data),
            username,
            newValues: data,
          });
        }

        // skipp auditing of GET requests if enabled and injected from plugin
        if (shouldAuditRequest(method, auditGetRequests, injected)) {
          emitAuditEvent(rec, routeEndpoint);
        }
      } catch (error) {
        handleError(request, error);
      }

      return h.continue;
    });

    setInterval(() => {
      oldValsCache = new Map();
    }, cacheExpiresIn);
  },
};
