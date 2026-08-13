# Private CA roots

Drop any PEM-encoded root certificate here — one file per CA, named `*.crt` —
and the image will trust it in both its build and runtime stages.

```
ca/company-ca.crt
```

You need this when the orchestrator has to make TLS connections that Debian's
and Node's shipped root stores cannot verify. In practice that means one of two
things:

- your GitLab is internal and its certificate is signed by a private CA, or
- a corporate proxy terminates and re-signs TLS on the way out.

Both surface the same way: `unable to get local issuer certificate`, either from
`npm ci` during the build or from the first GitLab API call at runtime.

## How it is wired

`Dockerfile` copies this whole directory into
`/usr/local/share/ca-certificates/` and runs `update-ca-certificates`, then sets
`NODE_EXTRA_CA_CERTS` to the rebuilt system bundle. Node ignores the operating
system's trust store by default, so that last step is what makes a certificate
`curl` already accepts also work inside Node.

The directory is copied wholesale rather than by filename so that the build
works unchanged whether or not you have a private CA — with only `.gitkeep`
present, `update-ca-certificates` finds no `.crt` and does nothing.

## Do not commit a private key

Root certificates are public by nature; there is nothing secret in a `.crt`.
A `.key` file is a different matter and does not belong here, or anywhere in
this repository.
