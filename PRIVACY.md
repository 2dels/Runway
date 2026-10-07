# Data boundary

The shipped default plan has zero monetary values, no paydays, no cards, no bills, no deadlines, no cancelled services, and no transaction or account history. Its fixed neutral dates are schema placeholders; setup supplies actual dates. Test merchants, accounts, and money amounts are invented fixtures.

The application never reads an existing ARCHi profile. The standalone host chooses a separate home-directory profile. The optional adapter accepts an explicit absolute directory from its host. The renderer receives only the finance bridge; it cannot select arbitrary filesystem paths, launch external sites, access Node.js, or call the host's other IPC operations through that bridge.

Imports begin with a user-selected local file. Its filename and transaction/account details are saved only in the user's local finance file. The runtime makes no bank, analytics, model, or cloud requests. Dependency installation and GitHub itself use the network separately from application use.

Financial data and the prior-save backup are unencrypted local files. Normal device/account permissions protect access. There is no automated synchronization, cross-device conflict resolution, backup service, or recovery account.

Release checks inspect the distributable file list, reject unexpected files and common secret/path patterns, and assert empty defaults. These checks supplement human source review; they are not a claim that any future modification is automatically safe to publish. Never add an actual profile or financial export as a test fixture.
