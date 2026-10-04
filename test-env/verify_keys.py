from cryptography.hazmat.primitives.asymmetric import ed25519
from cryptography.hazmat.primitives import serialization
import binascii

# The test seed I provided (32 bytes)
seed_hex = "49514eaf037920150d18e38d7ae9ef278631ed6263ebcf189912be7c87c0fa0a"
seed = binascii.unhexlify(seed_hex)

# In cryptography, NewKeyFromSeed is equivalent to from_private_bytes
priv_key = ed25519.Ed25519PrivateKey.from_private_bytes(seed)
pub_key = priv_key.public_key()
pub_bytes = pub_key.public_bytes(
    encoding=serialization.Encoding.Raw,
    format=serialization.PublicFormat.Raw
)

print(f"Seed: {seed_hex}")
print(f"Public Key: {binascii.hexlify(pub_bytes).decode()}")
