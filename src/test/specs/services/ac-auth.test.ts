import * as request from '@automationcloud/request';
import assert from 'assert';
import { Container } from 'inversify';

import {
    AcAuthProvider,
    AuthenticationError,
    Config,
    ConsoleLogger,
    DefaultAcAuthProvider,
    DefaultConfig,
    JwtService,
    Logger,
} from '../../../main';

describe('AcAuthProvider', () => {

    const container = new Container({ skipBaseClassChecks: true });
    container.bind(Logger).to(ConsoleLogger);
    container.bind(DefaultAcAuthProvider).toSelf();
    container.bind(AcAuthProvider).toService(DefaultAcAuthProvider);
    container.bind('KoaContext').toDynamicValue(() => ({
        req: { headers }
    }));
    container.bind(JwtService).toDynamicValue(() => ({
        async decodeAndVerify(token: string) {
            if (token !== 'jwt-token-here') {
                throw new AuthenticationError();
            }
            return jwt;
        }
    }));
    container.bind(Config).to(DefaultConfig);

    let fetchMock: request.FetchMock;
    let authProvider: DefaultAcAuthProvider;
    let headers: any = {};
    let jwt: any = {};

    beforeEach(() => {
        fetchMock = request.fetchMock({ status: 200 }, { token: 'jwt-token-here' });
        authProvider = container.get(DefaultAcAuthProvider);
        authProvider.clientRequest.config.fetch = fetchMock;
    });

    afterEach(() => {
        jwt = {};
        headers = {};
        DefaultAcAuthProvider.middlewareTokensCache = new Map();
    });

    describe('x-ubio-auth header exists', () => {

        beforeEach(() => {
            const authHeader = container.get(DefaultAcAuthProvider).AC_AUTH_HEADER_NAME;
            headers[authHeader] = 'Bearer jwt-token-here';
        });

        it('does not send request to authMiddleware', async () => {
            await authProvider.provide();
            assert.strictEqual(fetchMock.spy.called, false);
        });

        it('sets authenticated = true', async () => {
            const auth = await authProvider.provide();
            assert(auth.isAuthenticated());
        });

        it('throws when jwt is not valid', async () => {
            const authHeader = container.get(DefaultAcAuthProvider).AC_AUTH_HEADER_NAME;
            headers[authHeader] = 'Bearer unknown-jwt-token';
            try {
                await authProvider.provide();
                throw new Error('UnexpectedSuccess');
            } catch (err) {
                assert.strictEqual(err.name, 'AuthenticationError');
            }
        });

    });

    describe('middleware auth', () => {
        it('sends a request to auth middleware with Authorization header', async () => {
            headers['authorization'] = 'AUTH';
            assert.strictEqual(fetchMock.spy.called, false);
            const auth = await authProvider.provide();
            assert.strictEqual(fetchMock.spy.called, true);
            const requestHeaders = fetchMock.spy.params[0]?.fetchOptions.headers;
            assert.strictEqual(requestHeaders?.authorization, 'AUTH');
            assert.strictEqual(auth.isAuthenticated(), true);
        });

        it('does not send request if Authorization is cached', async () => {
            const ttl = 60000;
            const margin = 1000;
            DefaultAcAuthProvider.middlewareCacheTtl = ttl;
            DefaultAcAuthProvider.middlewareTokensCache.set('AUTH', {
                token: 'jwt-token-here',
                authorisedAt: Date.now() - ttl + margin
            });
            headers['authorization'] = 'AUTH';
            assert.strictEqual(fetchMock.spy.called, false);
            const auth = await authProvider.provide();
            assert.strictEqual(fetchMock.spy.called, false);
            assert.strictEqual(auth.isAuthenticated(), true);
        });

        it('sends request if cache has expired', async () => {
            const ttl = 60000;
            const margin = 1000;
            DefaultAcAuthProvider.middlewareCacheTtl = ttl;
            DefaultAcAuthProvider.middlewareTokensCache.set('AUTH', { token: 'jwt-token-here', authorisedAt: Date.now() - ttl - margin });
            headers['authorization'] = 'AUTH';
            assert.strictEqual(fetchMock.spy.called, false);
            const auth = await authProvider.provide();
            assert.strictEqual(fetchMock.spy.called, true);
            assert.strictEqual(auth.isAuthenticated(), true);
        });

        it('throws 401 if upstream request fails', async () => {
            authProvider.clientRequest.config.fetch = request.fetchMock({ status: 400 }, {}, new Error('RequestFailed'));
            headers['authorization'] = 'AUTH';
            try {
                await authProvider.provide();
                throw new Error('UnexpectedSuccess');
            } catch (err) {
                assert.strictEqual(err.status, 401);
            }
        });
    });

    context('authorization header does not exist', () => {
        it('leaves auth unauthenticated without throwing', async () => {
            const auth = await authProvider.provide();
            assert.strictEqual(auth.isAuthenticated(), false);
        });

    });

    describe('acAuth', () => {
        beforeEach(() => {
            const authHeader = container.get(DefaultAcAuthProvider).AC_AUTH_HEADER_NAME;
            headers[authHeader] = 'Bearer jwt-token-here';
        });

        describe('organisation_id', () => {
            context('jwt has `organisation_id`', () => {
                it('sets auth.organisationId', async () => {
                    jwt.context = { organisation_id: 'some-user-org-id' };
                    const auth = await authProvider.provide();
                    const organisationId = auth.getOrganisationId();
                    assert.strictEqual(organisationId, 'some-user-org-id');
                });
            });

            context('x-ubio-organisation-id presents in header', () => {
                it('sets auth.organisationId', async () => {
                    headers['x-ubio-organisation-id'] = 'org-id-from-header';
                    const auth = await authProvider.provide();
                    const organisationId = auth.getOrganisationId();
                    assert.strictEqual(organisationId, 'org-id-from-header');
                });
            });

            context('both jwt and x-ubio-organisation-id present', () => {
                it('sets auth.organisationId with value from jwt', async () => {
                    jwt.context = { organisation_id: 'org-id-from-jwt' };
                    headers['x-ubio-organisation-id'] = 'org-id-from-header';
                    const auth = await authProvider.provide();
                    const organisationId = auth.getOrganisationId();
                    assert.strictEqual(organisationId, 'org-id-from-jwt');
                });
            });
        });

        describe('getActor#ServiceAccount', () => {
            context('jwt has service_account_id and service_account_name', () => {
                it('returns serviceAccount from auth', async () => {
                    jwt.context = {
                        service_account_id: 'some-service-account-id',
                        service_account_name: 'Bot'
                    };
                    const auth = await authProvider.provide();
                    const serviceAccount = auth.getActor('ServiceAccount');
                    assert.ok(serviceAccount?.type === 'ServiceAccount');
                    assert.strictEqual(serviceAccount.id, 'some-service-account-id');
                    assert.strictEqual(serviceAccount.name, 'Bot');
                });

                it('returns organisationId if available', async () => {
                    jwt.context = {
                        service_account_id: 'some-service-account-id',
                        service_account_name: 'Bot',
                        organisation_id: 'ubio-organisation-id',
                    };
                    const auth = await authProvider.provide();
                    const serviceAccount = auth.getActor('ServiceAccount');
                    assert.ok(serviceAccount?.type === 'ServiceAccount');
                    assert.strictEqual(serviceAccount.id, 'some-service-account-id');
                    assert.strictEqual(serviceAccount.name, 'Bot');
                });

                it('returns contains client info', async () => {
                    jwt.context = {
                        service_account_id: 'Bot',
                        service_account_name: 'Nick Offerman',
                        client_id: 'ClientA',
                        client_name: 'Ron Swanson',
                    };
                    const auth = await authProvider.provide();
                    const serviceAccount = auth.getActor('ServiceAccount');
                    assert.ok(serviceAccount?.type === 'ServiceAccount');
                    assert.strictEqual(serviceAccount.clientId, 'ClientA');
                    assert.strictEqual(serviceAccount.clientName, 'Ron Swanson');
                });

                it('returns null if `allowedRoles` do not include ServiceAccount', async () => {
                    jwt.context = {
                        service_account_id: 'Bot',
                        service_account_name: 'Nick Offerman',
                        client_id: 'ClientA',
                        client_name: 'Ron Swanson',
                    };
                    const auth = await authProvider.provide();
                    const serviceAccount = auth.getActor('Client');
                    assert.ok(serviceAccount == null);
                });
            });
        });

        describe('getActor#Client', () => {
            context('jwt has client_id and client_name', () => {
                it('returns Client actor from auth', async () => {
                    jwt.context = {
                        client_id: 'some-client-id',
                        client_name: 'UbioAir',
                        organisation_id: 'ubio-organisation-id',
                    };
                    const auth = await authProvider.provide();
                    const client = auth.getActor('Client');
                    assert.ok(client?.type === 'Client');
                    assert.strictEqual(client.id, 'some-client-id');
                    assert.strictEqual(client.name, 'UbioAir');
                });

                it('does not return Client actor if job_id is present', async () => {
                    headers['authorization'] = 'AUTH';
                    jwt.context = {
                        job_id: 'some-job-id-from-cliend-ubio-air',
                        organisation_id: 'ubio-organisation-id',
                        client_id: 'some-client-id',
                        client_name: 'UbioAir',
                    };
                    const auth = await authProvider.provide();
                    const client = auth.getActor('Client');
                    assert.ok(client == null);
                });
            });
        });

        describe('getActor#User', () => {
            context('jwt has user_id, user_name and organisation_id', () => {
                it('returns User actor', async () => {
                    jwt.context = {
                        user_id: 'some-user-id',
                        user_name: 'Travel Aggregator',
                        organisation_id: 'ubio-organisation-id',
                    };
                    const auth = await authProvider.provide();
                    const user = auth.getActor('User');
                    assert.ok(user?.type === 'User');
                    assert.strictEqual(user.id, 'some-user-id');
                    assert.strictEqual(user.name, 'Travel Aggregator');
                });
            });

            context('missing some info', () => {
                it('does not return Client actor when user_name is missing', async () => {
                    jwt.context = {
                        user_id: 'some-user-id',
                        organisation_id: 'ubio-organisation-id',
                    };
                    const auth = await authProvider.provide();
                    const user = auth.getActor('User');
                    assert.ok(user == null);
                });
            });
        });

        describe('JobAccessToken', () => {
            context('jwt has job_id, client_id, client_name and organisation_id', () => {
                it('returns JobAccessToken actor', async () => {
                    jwt.context = {
                        job_id: 'some-job-id',
                        client_id: 'some-client-id',
                        client_name: 'UbioAir',
                        organisation_id: 'ubio-organisation-id',
                    };
                    const auth = await authProvider.provide();
                    const jobAccessToken = auth.getActor('JobAccessToken');
                    assert.ok(jobAccessToken?.type === 'JobAccessToken');
                    assert.strictEqual(jobAccessToken.jobId, 'some-job-id');
                    assert.strictEqual(jobAccessToken.clientId, 'some-client-id');
                    assert.strictEqual(jobAccessToken.clientName, 'UbioAir');
                });
            });

            context('missing required data', () => {
                it('does not return Client actor when user_name is missing', async () => {
                    jwt.context = {
                        job_id: 'some-job-id',
                        organisation_id: 'ubio-organisation-id',
                    };
                    const auth = await authProvider.provide();
                    const jobAccessToken = auth.getActor('JobAccessToken');
                    assert.ok(jobAccessToken == null);
                });

                it('does not return Client actor when organisation_id is missing', async () => {
                    jwt.context = {
                        user_id: 'some-user-id',
                        user_name: 'Travel Aggregator',
                    };
                    const auth = await authProvider.provide();
                    const jobAccessToken = auth.getActor('JobAccessToken');
                    assert.ok(jobAccessToken == null);
                });
            });
        });
    });
});
