# Webhook imzalarının doğrulanması

Halyard gönderdiği her isteği imzalar. İmzanın doğrulanması alıcının işidir ve Halyard bunu zorlayamaz;
doğrulamayan bir alıcı, adresini öğrenen herkesten webhook kabul ediyor demektir.

## İlgili başlıklar

| Başlık | İçerik |
|---|---|
| `X-Halyard-Signature` | `v1=` öneki ve ardından onaltılık imza. Birden çok imza virgülle ayrılabilir. |
| `X-Halyard-Signature-Timestamp` | Unix saniyesi. Gövdeyle birlikte imzalanır. |
| `X-Halyard-Delivery-Id` | Yineleme ayıklaması için kullanılacak değer. |
| `X-Halyard-Attempt` | 1'den başlayan deneme numarası. 2.6.3 öncesinde 0'dan başlıyordu. |

## İmzalanan dizi

İmzalanan şey gövdenin kendisi değil, şu üç parçanın nokta ile birleştirilmiş hâlidir:

```
<zaman-damgasi>.<gonderim-kimligi>.<ham-govde>
```

Gövdenin ham baytları kullanılır. Çerçevenizin JSON'u ayrıştırıp yeniden serileştirmesinden sonra elde
edilen dizi neredeyse her zaman farklıdır — boşluklar, alan sırası, sayı biçimlendirmesi — ve doğrulama
başarısızlıklarının açık ara en sık nedeni budur.

## HMAC-SHA256 ile doğrulama

```python
import hashlib, hmac, time

def dogrula(govde: bytes, basliklar: dict, gizli: bytes, tolerans: int = 300) -> bool:
    zaman = int(basliklar["X-Halyard-Signature-Timestamp"])
    if abs(time.time() - zaman) > tolerans:
        return False
    kimlik = basliklar["X-Halyard-Delivery-Id"]
    veri = f"{zaman}.{kimlik}.".encode() + govde
    beklenen = hmac.new(gizli, veri, hashlib.sha256).hexdigest()
    for parca in basliklar["X-Halyard-Signature"].split(","):
        surum, _, imza = parca.strip().partition("=")
        if surum == "v1" and hmac.compare_digest(beklenen, imza):
            return True
    return False
```

Karşılaştırmanın sabit zamanlı yapılması önemlidir. `hmac.compare_digest` bunu sağlar; `==` sağlamaz.

## Zaman damgası neden imzalanıyor

Zaman damgası imzalanmasaydı, yakalanmış bir isteği daha sonra yeniden göndermek mümkün olurdu ve imza
hâlâ geçerli görünürdü. Zaman damgası imzanın içinde olduğu için, eski bir isteğin yeniden oynatılması
alıcı tarafından saptanabilir.

Tolerans `HALYARD_SIGNATURE_TOLERANCE` değeriyle yayımlanır, varsayılanı beş dakikadır ve bu değeri
uygulayan taraf alıcıdır. Tolerans dışında kalan bir zaman damgası bildirildiğinde Halyard bunu
`HLY-3005` olarak kaydeder. Bu kod neredeyse her zaman bir saat sorunudur; gizli anahtarın farklı olması
çok daha nadir bir nedendir ve genellikle ilk bakılan yerdir.

## Ed25519 ile doğrulama

`HALYARD_SIGNING_ALGORITHM=ed25519` ayarlandığında imza, aynı dizinin Ed25519 imzasıdır ve onaltılık
olarak yine `v1=` önekiyle taşınır. Açık anahtarı `GET /v1/signing-keys` ucundan alabilirsiniz; uç,
kimlik doğrulaması gerektirmez, çünkü açık anahtarın gizlenecek bir yanı yoktur.

Anahtar değişiminde eski ve yeni anahtar bir süre birlikte yayımlanır ve gönderimler `X-Halyard-Signature`
başlığında iki imza birden taşır. Alıcının, imzalardan herhangi birinin bilinen anahtarlardan biriyle
doğrulanmasını yeterli sayması gerekir — başlığı tek imza içeriyormuş gibi ayrıştıran alıcılar anahtar
değişiminde kırılır.

## Algoritmanın değiştirilmesi

`HALYARD_SIGNING_ALGORITHM` değiştirildiğinde yalnızca bundan sonraki gönderimler yeni algoritmayla
imzalanır. Uçuşta olan gönderimler imzalandıkları algoritmayla kalır. Dolayısıyla geçiş sırasında
alıcınızın her iki doğrulamayı da bir süre desteklemesi gerekir; aksi hâlde geçiş anında kuyrukta
bekleyen gönderimler reddedilir.
