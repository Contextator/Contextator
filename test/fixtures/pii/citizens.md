# Customer import notes

The importer reads the citizen number and the IBAN of each customer. The numbers below are invented: they pass
the public checksums and belong to nobody.

| Customer | Citizen number | IBAN |
| -------- | -------------- | ---- |
| A        | 10000000146    | TR33 0006 1005 1978 6457 8413 26 |
| B        | 10000000147    | TR33 0006 1005 1978 6457 8413 27 |
| C        | 00000000000    | DE89 3704 0044 0532 0130 00 |

Row B has a citizen number whose last digit is wrong and an IBAN whose check digits do not hold. Both are typos,
and neither should be reported. Order 12345678901 is an order number.
