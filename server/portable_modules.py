"""Compatibility imports. New code should import from estu_services directly."""

from estu_services.lookups import (
    model_for_board as model_for_board,
    department_exists as department_exists,
    default_department as default_department,
)
from estu_services.requests import (
    validate_status as validate_status,
    validate_assignment as validate_assignment,
    request_response as request_response,
    add_request as add_request,
    update_request as update_request,
    delete_request as delete_request,
    complete_request as complete_request,
)
from estu_services.snapshot import (
    get_state as get_state,
)
from estu_services.fleet import (
    add_fleet as add_fleet,
    update_fleet as update_fleet,
    remove_fleet as remove_fleet,
)
from estu_services.navigation import (
    navigation_record as navigation_record,
    get_navigation as get_navigation,
    save_navigation as save_navigation,
    import_navigation as import_navigation,
)
from estu_services.equipment import (
    get_bso as get_bso,
    save_bso_records as save_bso_records,
    bso_history as bso_history,
)
from estu_services.history import (
    update_history as update_history,
    delete_history as delete_history,
)
