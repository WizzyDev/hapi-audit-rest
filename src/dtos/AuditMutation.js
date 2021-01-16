import { AUDIT_OUTCOME, EVENT_TYPE, MUTATION_ACTION } from "../enums";
import AuditMutationBody from "./AuditMutationBody";

class AuditMutation {
  constructor(input) {
    const {
      method,
      action,
      entity,
      entityId,
      username,
      outcome = AUDIT_OUTCOME.SUCCESS,
      application,
      originalValues = {},
      newValues = {},
    } = input;
    let httpAction = null;

    if (!action && `${method}`.toLowerCase() === "put") {
      httpAction = MUTATION_ACTION.MUTATION_UPDATE;
    } else if (!action && `${method}`.toLowerCase() === "post") {
      httpAction = MUTATION_ACTION.MUTATION_CREATE;
    } else if (!action && `${method}`.toLowerCase() === "delete") {
      httpAction = MUTATION_ACTION.MUTATION_DELETE;
    }

    this.application = application;
    this.type = EVENT_TYPE.MUTATION;
    this.body = new AuditMutationBody({
      entity,
      action: action || httpAction,
      entityId,
      username,
      originalValues,
      newValues,
    });
    this.outcome = outcome;
  }
}

export default AuditMutation;
