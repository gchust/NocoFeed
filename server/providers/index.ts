import SubmissionProvider from './submission.js';
import FeedProvider from './feed/index.js';
import type { ApplicationServiceProviderConstructor } from '@nocobase/app-server/application';

const serviceProviders: readonly ApplicationServiceProviderConstructor[] = [
  SubmissionProvider,
  FeedProvider,
];

export default serviceProviders;
