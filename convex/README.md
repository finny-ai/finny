# Welcome to your Convex functions directory!

Write your Convex functions here.
See https://docs.convex.dev/functions for more.

A query function that takes two arguments looks like:

```ts
// convex/myFunctions.ts
import { query } from "./_generated/server";
import { v } from "convex/values";

export const myQueryFunction = query({
  // Validators for arguments.
  args: {
    first: v.number(),
    second: v.string(),
  },

  // Function implementation.
  handler: async (ctx, args) => {
    // Read the database as many times as you need here.
    // See https://docs.convex.dev/database/reading-data.
    const documents = await ctx.db.query("tablename").collect();

    // Arguments passed from the client are properties of the args object.
    console.log(args.first, args.second);

    // Write arbitrary JavaScript here: filter, aggregate, build derived data,
    // remove non-public properties, or create new objects.
    return documents;
  },
});
```

Using this query function in a React component looks like:

```ts
const data = useQuery(api.myFunctions.myQueryFunction, {
  first: 10,
  second: "hello",
});
```

A mutation function looks like:

```ts
// convex/myFunctions.ts
import { mutation } from "./_generated/server";
import { v } from "convex/values";

export const myMutationFunction = mutation({
  // Validators for arguments.
  args: {
    first: v.string(),
    second: v.string(),
  },

  // Function implementation.
  handler: async (ctx, args) => {
    // Insert or modify documents in the database here.
    // Mutations can also read from the database like queries.
    // See https://docs.convex.dev/database/writing-data.
    const message = { body: args.first, author: args.second };
    const id = await ctx.db.insert("messages", message);

    // Optionally, return a value from your mutation.
    return await ctx.db.get("messages", id);
  },
});
```

Using this mutation function in a React component looks like:

```ts
const mutation = useMutation(api.myFunctions.myMutationFunction);
function handleButtonPress() {
  // fire and forget, the most common way to use mutations
  mutation({ first: "Hello!", second: "me" });
  // OR
  // use the result once the mutation has completed
  mutation({ first: "Hello!", second: "me" }).then((result) =>
    console.log(result),
  );
}
```

Use the Convex CLI to push your functions to a deployment. See everything
the Convex CLI can do by running `npx convex -h` in your project root
directory. To learn more, launch the docs with `npx convex docs`.

## Legacy Finny License Checks

The commercial license source of truth lives in `finny-platform`, not in this
runtime repo. The local Finny client calls `https://api.finnyai.tech/v1/license/check`
by default. `FINNY_LICENSE_CHECK_URL` can override this for development.

The customer-facing install and activation flow is:

```bash
npm i -g finny-pro
finny-pro --license-key finny_...
```

The future platform endpoint resolves organization, plan, seat, and device
policy server-side from the license key. Do not add new commercial licensing
tables or source-of-truth behavior to this repo.

The client-facing route returns `200 OK` or `403 Forbidden` with user-safe JSON.

Client payload is limited to:

- `licenseKeyHash`
- `machineIdHash`
- `appVersion`
- `client`
- `timestamp`

Do not add requested feature, plan, seat count, prompt text, strategy code,
symbols, market data, backtest metrics, P&L, or extra fields to this request.
Plan and device policy resolution stays server-side in `finny-platform`.

For local development only, `FINNY_LICENSE_BYPASS=1` skips the client gate.
Pilot/customer builds should not set it.
