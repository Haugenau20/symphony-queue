/**
 * Construction of review pipeline components from configuration.
 *
 * This exists as its own module for a specific reason. These factories belong
 * logically in main.ts, beside the rest of the wiring — but main.ts calls
 * `main()` at module load, so importing it to test a factory BOOTS THE CLI.
 * Doing that under vitest produced an unhandled `process.exit(1)` rejection
 * and vitest's own warning that it "might cause false positive tests", which
 * is not a warning to accept in a phase whose recurring bug is a green suite
 * agreeing with broken wiring.
 *
 * The alternative — guarding `main()` behind an is-this-the-entrypoint check —
 * would change how the service boots, and this session cannot run the
 * container to prove it still does. Moving the factory is free and provable;
 * changing the boot condition is neither.
 */

import { ReviewPublisher } from './publisher.js'
import type { ReviewConfig } from '../config.js'

/**
 * The line that decides whether inline discussions happen at all.
 *
 * The publisher's own default is `false`, so dropping the `inlineComments`
 * argument here turns the entire feature off in production. When this was a
 * bare `new ReviewPublisher(...)` inside main.ts's `runReviewMode`, doing
 * exactly that left the whole suite green and the typecheck clean — every
 * other test in this phase builds its own publisher, so none of them can see
 * whether the real wiring passes the flag.
 *
 * That was the third instance of one shape of bug in this phase: correct code,
 * correct tests, and one unexercised wire between them. The other two were the
 * worker mapping the diff bodies away, and the publisher reading them from a
 * field nothing populated.
 *
 * Inline discussions are the publisher's job alone: the worker is not told
 * about them and its client type cannot reach them. The flag is passed
 * explicitly rather than left to the publisher's default, so config.ts remains
 * the single place the shipped default lives.
 */
export function buildReviewPublisher(
  client: ConstructorParameters<typeof ReviewPublisher>[0]['mrClient'],
  config: Pick<ReviewConfig, 'inlineComments'>,
): ReviewPublisher {
  return new ReviewPublisher({ mrClient: client, inlineComments: config.inlineComments })
}
