# Zamanlanmış görevler

Zamanlama, bir cron ifadesi, bir hedef uç nokta ve bir yük şablonundan oluşur. Zamanlayıcı saniyede bir
uyanır, vakti gelmiş zamanlamaları bulur ve her biri için sıradan bir olay yayımlar. Yani zamanlanmış bir
görev, yayımlayıcısı insan yerine zamanlayıcı olan bir olaydır; gönderim, yeniden deneme ve imzalama
kuralları birebir aynıdır.

## İfade sözdizimi

Beş alanlı standart cron sözdizimi kullanılır: dakika, saat, ayın günü, ay, haftanın günü. Ek olarak
`@hourly`, `@daily`, `@weekly`, `@monthly` ve `@yearly` kısayolları kabul edilir. Saniye alanı yoktur;
saniye hassasiyetinde bir tetikleme gerekiyorsa bu bir zamanlama değil, bir çalışan sürecin işidir.

```json
{
  "name": "gunluk-mutabakat",
  "expression": "15 3 * * *",
  "timezone": "Europe/Istanbul",
  "endpoint_id": "ep_01J8ZC",
  "event_type": "mutabakat.baslat",
  "payload": {"kapsam": "gunluk"},
  "overlap": "skip"
}
```

`timezone` alanı yazılmadığında `HALYARD_SCHEDULER_TIMEZONE` geçerlidir, o da yazılmadığında `UTC`
kullanılır. Yalnızca IANA tanımlayıcıları kabul edilir; `EST` gibi kısaltmalar `HLY-6001` ile
reddedilir, çünkü kısaltmalar yaz saati geçişlerini tanımlamaya yetmez.

## Yaz saati geçişleri

Yerel saate göre tanımlanmış bir zamanlama, ilkbahar geçişinde var olmayan bir saate denk gelirse o gün
atlanır; sonbahar geçişinde iki kez yaşanan bir saate denk gelirse yalnızca bir kez tetiklenir.
İkisi de kayıt altına alınır. Bu davranışı istemiyorsanız zamanlamayı `UTC` üzerinden tanımlayın — o
zaman geçişler sizin açınızdan hiç var olmaz.

## Üst üste binme

`overlap` alanı üç değer alır:

- `skip` — önceki çalıştırma hâlâ uçuştaysa yeni oluşum atlanır ve `HLY-6003` olarak sayılır. Varsayılan.
- `queue` — oluşum sıraya alınır ve öncekinin bitmesi beklenir.
- `allow` — koşulsuz tetiklenir.

`skip` değerinin varsayılan olması bilinçlidir, ama sessizce kabullenilecek bir durum değildir. Düzenli
olarak atlanan bir zamanlama, işi kendi aralığından uzun süren bir zamanlamadır ve bu kendiliğinden
düzelmez. `halyard_schedule_runs_total{result="skipped"}` serisinin sıfırdan büyük olması uyarıya
değecek bir durumdur.

## Kaçırılan oluşumlar

Hiçbir kopya çalışmadığı için kaçırılan oluşumlar, `HALYARD_SCHEDULER_CATCHUP_WINDOW` süresi içinde
kaldıkları sürece sonradan tetiklenir. Varsayılan bir saattir. Bu pencereden daha eski oluşumlar
tetiklenmez, `HLY-6004` olarak sayılır ve günlüğe yazılır.

Pencereyi büyütürken dikkatli olun: uzun bir kesintinin ardından, biriken bütün oluşumların art arda
tetiklenmesi, alıcınız için kesintinin kendisinden daha ağır bir yük olabilir.

## Birden çok kopyada zamanlayıcı

`HALYARD_SCHEDULER_ENABLED` değeri bütün kopyalarda açık bırakılabilir. Her oluşum için zamanlama
başına bir kiralama alınır ve oluşumu yalnızca kiralamayı alan kopya tetikler. 2.6.0 öncesinde bu
kiralama yoktu ve kurulumun kendisi tek bir kopyada zamanlayıcıyı açık tutmayı ayarlamak zorundaydı.

Yalnızca gönderim yapması istenen bir kopyada zamanlayıcıyı kapatmak isterseniz `--no-scheduler` bayrağı
ya da `HALYARD_SCHEDULER_ENABLED=false` yeterlidir. Kalıcı olarak ve geri alınamaz biçimde kapatmak
istiyorsanız, ikiliyi `TAGS=noscheduler` ile derlemek daha güvenilirdir; sonradan bir ortam dosyasını
düzenleyen kimse onu geri açamaz.
