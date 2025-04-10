import ApiError from '../shared/ApiError';
import { ApiContract, ApiMethodResponse, ApiMethodResponseSuccess } from '../shared/types';
import queueMicrotask from './queueMicrotask';

interface ApiItem {
    method: string;
    params: Record<string, unknown> | Record<string, unknown>[];
    resolve(data: unknown): void;
    reject(err: unknown): void;
}

interface ApiOptions {
    url: string;
    csrfToken?: string;
    batchMaxSize?: number;
    timeout?: number;
    headers?:
        RequestInit['headers'] |
        (() => RequestInit['headers']);
    searchParams?: URLSearchParams | (() => URLSearchParams);
}

const DEFAULT_API_OPTIONS = {
    batchMaxSize: 1,
    csrfToken: '',
    timeout: 30000,
    headers: {},
    searchParams: new URLSearchParams()
};
const MAX_RETRIES = 2;

class Api<TApiContract extends ApiContract> {
    private options: Required<ApiOptions>;
    private queue: ApiItem[] = [];

    constructor(options: ApiOptions) {
        this.options = {
            ...DEFAULT_API_OPTIONS,
            ...options
        };
    }

    exec<TMethod extends Extract<keyof TApiContract, string>>(
        ...[method, params = {}]: TApiContract[TMethod]['params'] extends Record<string, never> ?
            [TMethod] :
            [TMethod, TApiContract[TMethod]['params']]
    ): Promise<TApiContract[TMethod]['result']> {
        return new Promise((resolve, reject) => {
            const { options, queue } = this;

            if(options.batchMaxSize > 1) {
                queue.push({ method, params, resolve, reject });

                switch(queue.length) {
                    case options.batchMaxSize:
                        this.processQueue();
                        break;

                    case 1:
                        queueMicrotask(this.processQueue);
                        break;
                }
            } else {
                this.doRequest({
                    reject,
                    method,
                    params,
                    resolve: (res: ApiMethodResponse) => {
                        this.handleMethodResponse(res, resolve, reject);
                    }
                });
            }
        });
    }

    private processQueue = (): void => {
        const { queue } = this;

        if(queue.length === 0) {
            return;
        }

        this.queue = [];

        this.doRequest({
            method: 'batch',
            params: queue.map(({ method, params }) => ({ method, params })),
            resolve: ({ data }: ApiMethodResponseSuccess<ApiMethodResponse[]>) => {
                queue.forEach(({ resolve, reject }, i) => {
                    const item = data[i];

                    if(typeof item !== 'object' || item === null) {
                        reject('Incompatible format, expected object with data or error field');
                    }

                    this.handleMethodResponse(item, resolve, reject);
                });
            },
            reject: (err: ApiError) => {
                queue.forEach(({ reject }) => {
                    reject(err);
                });
            }
        });
    };

    private doRequest(
        { resolve, reject, method, params, retries = 0 }: ApiItem & { retries?: number; }
    ): void {
        const { url, csrfToken, timeout, headers, searchParams } = this.options;
        let timeoutCancellationToken: number | null = window.setTimeout(
            () => {
                timeoutCancellationToken = null;
                reject(new ApiError(ApiError.TIMEOUT));
            },
            timeout
        );

        const queryString = (typeof searchParams === 'function' ? searchParams() : searchParams).toString();
        const search = queryString ? `?${queryString}` : '';

        fetch(
            `${url}/${method}${search}`,
            {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    ...typeof headers === 'function' ? headers() : headers,
                    ...csrfToken ?
                        { 'X-Csrf-Token': csrfToken } :
                        undefined
                },
                body: JSON.stringify(params)
            }
        ).then(
            response => {
                if(timeoutCancellationToken === null) {
                    throw new ApiError(ApiError.TIMEOUT);
                }

                window.clearTimeout(timeoutCancellationToken);

                if(csrfToken) {
                    const newCsrfToken = response.headers.get('X-Csrf-Token');

                    if(newCsrfToken && newCsrfToken !== csrfToken) {
                        this.options.csrfToken = newCsrfToken;

                        throw new ApiError(ApiError.WRONG_CSRF_TOKEN);
                    }
                }
               
                if(response.ok) {
                    return response.json().catch(err => {
                        throw new ApiError(ApiError.INTERNAL_ERROR, err.message, err);
                    });
                }   

                throw new ApiError(ApiError.INTERNAL_ERROR, response.statusText);
            },
            err => {
                if(timeoutCancellationToken === null) {
                    throw new ApiError(ApiError.TIMEOUT);
                }

                window.clearTimeout(timeoutCancellationToken);
                throw new ApiError(ApiError.INTERNAL_ERROR, err.message, err);
            }
        ).then((res: ApiMethodResponse) => {
            if(typeof res === 'object' && res !== null) {
                resolve(res);
            } else {
                throw new ApiError(ApiError.INTERNAL_ERROR, 'Incompatible response format');
            }
        }).catch(err => {
            if(err && err.type === ApiError.WRONG_CSRF_TOKEN && retries < MAX_RETRIES) {
                this.doRequest({ resolve, reject, method, params, retries: retries + 1 });
            } else {
                reject(err);
            }
        });
    }

    private handleMethodResponse(
        response: ApiMethodResponse,
        resolve: (data: unknown) => void,
        reject: (err: unknown) => void,
    ): void {
        if(response.error) {
            reject(new ApiError(response.error.type, response.error.message, response.error.data));
        } else {
            resolve(response.data);
        }
    }
}

export default Api;
export { ApiOptions };
