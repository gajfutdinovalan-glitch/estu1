const STATUS_META = {
  new: {label: 'Новая', className: 'new'},
  waiting: {label: 'Ожидает', className: 'wait'},
  in_progress: {label: 'В работе', className: 'progress'},
  completed: {label: 'Выполнено', className: 'ok'},
  rejected: {label: 'Отклонено', className: 'wait'}
};

const ROLE_META = {
  admin: 'Администратор',
  manager: 'Мастер смены',
  executor: 'Исполнитель'
};

const ACCESS_SCOPES = {
  rel: {
    label: 'Участок РЭЛ',
    hint: 'Электронный журнал, информаторы, учёт БСО, парк'
  },
  master: {
    label: 'Участок заявочных ремонтов',
    hint: 'Журнал заявок, парк и смены заявочного ремонта'
  },
  management: {
    label: 'Руководство',
    hint: 'Общий журнал заявок, парк и график смен'
  },
  pto: {
    label: 'ПТО', available: false
  },
  maintenance: {
    label: 'Участок технического обслуживания', available: false
  },
  warehouse: {
    label: 'Склад'
  },
  admin: {
    label: 'Администратор',
    hint: 'Все разделы системы и права доступа'
  }
};

const ACCESS_SCOPE_ROLE = {
  warehouse: 'executor',
  rel: 'executor',
  master: 'manager',
  management: 'manager',
  admin: 'admin'
};

const MODULES = {
  warehouse: {label: 'Склад', heroTitle: 'Склад и материалы', heroSubtitle: 'Остатки, потребности участков и выдачи', defaultTab: 'warehouse', tabs: ['warehouse'], roles: ['executor', 'manager', 'admin']},
  journal: {
    label: 'Электронный журнал',
    heroTitle: 'Электронный журнал заявочного ремонта',
    heroSubtitle: 'Заявки, активные ремонты и история выполненных работ',
    defaultTab: 'dashboard',
    tabs: ['dashboard', 'active', 'history', 'fleet'],
    roles: ['executor', 'manager', 'admin']
  },
  navigation: {
    label: 'Учёт информаторов и навигации на подвижном составе',
    heroTitle: 'Учёт информаторов и навигации на подвижном составе',
    heroSubtitle: 'Информаторы, Орбита и А/И Орбита по бортам',
    defaultTab: 'navigation',
    tabs: ['navigation'],
    roles: ['executor', 'admin']
  },
  navcontrol: {
    label: 'Контроль навигации',
    heroTitle: 'Контроль работы навигации',
    heroSubtitle: 'Утренние и вечерние отчёты по каждому борту подвижного состава',
    defaultTab: 'navControl',
    tabs: ['navControl', 'navControlMail'],
    roles: ['executor', 'admin']
  },
  fleet: {
    label: 'Парк',
    heroTitle: 'Парк подвижного состава',
    heroSubtitle: 'Общий каталог троллейбусов и история каждого борта',
    defaultTab: 'fleet',
    tabs: ['fleet'],
    roles: ['executor', 'manager', 'admin']
  },
  bso: {
    label: 'Учёт БСО',
    heroTitle: 'Учёт касс и кубов БСО',
    heroSubtitle: 'Комплектность и номера бортового оборудования',
    defaultTab: 'bsoFleet',
    tabs: ['bsoFleet', 'bsoEditor', 'bsoTable'],
    roles: ['executor', 'admin']
  },
  shifts: {
    label: 'Смены ЗР',
    heroTitle: 'Смены участка заявочных ремонтов',
    heroSubtitle: 'Дневные и ночные смены · график 2/2',
    defaultTab: 'shifts', tabs: ['shifts'], roles: ['manager', 'admin']
  },
  users: {
    label: 'Роли и права',
    heroTitle: 'Роли и права доступа',
    heroSubtitle: 'Профили входа, доступные системы и разрешения',
    defaultTab: 'users',
    tabs: ['users'],
    roles: ['admin']
  }
};

const PERMISSION_LABELS = {
  viewAllRequests: 'Видеть все заявки',
  createRequests: 'Создавать заявки',
  editRequests: 'Редактировать заявки',
  reassignRequests: 'Перераспределять и назначать',
  completeRequests: 'Закрывать заявки',
  deleteRequests: 'Удалять заявки',
  manageFleet: 'Редактировать парк',
  manageNavigation: 'Редактировать информаторы и навигацию',
  manageNavControl: 'Загружать отчёты контроля навигации',
  configureNavMail: 'Настраивать почту контроля навигации',
  manageBso: 'Редактировать учёт БСО',
  manageHistory: 'Редактировать историю',
  manageUsers: 'Управлять ролями',
  viewAudit: 'Журнал действий',
  manageShifts: 'Настраивать график смен заявочного ремонта'
};

const INFORMER_TYPES = ['Селена', 'Искра', 'ИР'];

const REQUEST_STATUS_ORDER = {new: 0, in_progress: 1, waiting: 2};

export { ACCESS_SCOPES, ACCESS_SCOPE_ROLE, INFORMER_TYPES, MODULES, PERMISSION_LABELS, REQUEST_STATUS_ORDER, ROLE_META, STATUS_META };
