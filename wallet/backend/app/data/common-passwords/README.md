# Passwords comunes ([B-AUTH-01])

Lista vendorizada para rechazar passwords de cuenta comunes sin llamadas externas.

| Campo                 | Valor                                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fuente                | [SecLists](https://github.com/danielmiessler/SecLists) (licencia MIT, ver `LICENSE-SecLists`)                                                                                |
| Archivo               | `Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt` (lista de 100.000 passwords más usadas del NCSC del Reino Unido, deduplicada por SecLists: 99.840 entradas) |
| Commit fijado         | `1a7bb9127eca9e6ff2fc0301c597fe6e16a0cb56` (2025-11-19, último cambio del archivo)                                                                                           |
| SHA-256 del contenido | `c2e5696882c603b76bb67a47ee970897e5a76fc4c3f5547abe3d0ca340c576e0`                                                                                                           |

Se guarda comprimido (`gzip -9n`, sin nombre ni fecha en el header) para no versionar 835 KB de texto. El backend
descomprime al primer uso, verifica el SHA-256 del contenido contra el valor de esta tabla y falla si no coincide
(`src/auth/common-passwords.ts`). Para actualizarla: descargar el archivo en un commit nuevo de SecLists, verificar
su origen, recomprimir con el mismo comando y actualizar el commit y el SHA-256 acá y en el código.
