/* power management */
#define PM_SUSPEND 1
#define PM_RESUME 2
static int on_event(int ev) { return ev == PM_RESUME; }
