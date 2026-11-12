import { asArray } from './format.js';

let state = {
  fleet: [],
  navigation: [],
  history: [],
  requests: [],
  departments: [],
  assignableUsers: [],
  currentUser: null,
  permissions: {}
};

let currentModule = null;

const can = (permission) => Boolean(state.permissions?.[permission]);

function normalizeState(value) {
  return {
    ...value,
    fleet: asArray(value?.fleet),
    navigation: asArray(value?.navigation),
    history: asArray(value?.history),
    requests: asArray(value?.requests),
    departments: asArray(value?.departments),
    assignableUsers: asArray(value?.assignableUsers),
    permissions: value?.permissions || {}
  };
}

function replaceState(nextState) {
  state = nextState;
}

function setCurrentModule(moduleId) {
  currentModule = moduleId;
}

export { can, currentModule, normalizeState, replaceState, setCurrentModule, state };
