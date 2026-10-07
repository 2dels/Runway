# Data boundary

The shipped default plan has zero monetary values, no paydays, no cards, no bills, no deadlines, no cancelled services, and no transaction or account history. Its fixed neutral dates are schema placeholders; setup supplies actual dates. Test merchants, accounts, and money amounts are invented fixtures.

The application never reads an existing ARCHi profile. The standalone host chooses a separate home-directory profile. The optional adapter accepts an explicit absolute directory from its host. The desktop renderer receives only the finance bridge; it cannot select arbitrary filesystem paths, launch external sites, access Node.js, or call the host's other IPC operations through that bridge.

The mobile version downloads application assets from its host. It sends no financial records to that host. Records are saved in IndexedDB on the current browser/device/origin, with transactional revision checks across tabs. The offline worker caches an allowlist of application assets only. Authentication pages, selected files, financial records, arbitrary URLs, and query-string requests are not cached by Runway's worker.

A mobile backup is a downloaded JSON file containing the user's financial records. Restoring requires a locally chosen valid file and explicit confirmation to replace this device's plan. It does not merge or synchronize devices. Clearing site/browser data can erase the plan; the persistent-storage request can reduce automatic eviction but cannot prevent manual clearing. Keep backups somewhere private. A hosted private shell still stores its financial records locally, independently of the hosting sign-in.

Desktop imports begin with a user-selected local file. Its filename and transaction/account details are saved only in the user's local finance file. Mobile restore reads only the file selected by the user. The runtime makes no bank, analytics, model, or cloud-data requests. Loading the hosted mobile application, dependency installation, and GitHub itself use the network separately from financial storage.

Financial data and the prior-save backup are unencrypted local files. Normal device/account permissions protect access. There is no automated synchronization, cross-device conflict resolution, backup service, or recovery account.

Release checks inspect the distributable file list, reject unexpected files and common secret/path patterns, and assert empty defaults. These checks supplement human source review; they are not a claim that any future modification is automatically safe to publish. Never add an actual profile or financial export as a test fixture.
