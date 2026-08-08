import { FINNY_BROKER_PY as BASE_FINNY_BROKER_PY } from "./broker-py"
import { ROBINHOOD_BROKER_PY } from "./robinhood-broker-py"

export const FINNY_LIVE_BROKER_PY = `${BASE_FINNY_BROKER_PY}\n${ROBINHOOD_BROKER_PY}`
