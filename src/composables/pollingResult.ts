// A poll callback can finish without owning any result: for example, a
// route/filter change may supersede the request while it is in flight.
// Keep this sentinel outside usePolling so view tests can mock the scheduler
// without also having to duplicate its result protocol.
export const POLLING_STALE = Symbol('polling-stale')
