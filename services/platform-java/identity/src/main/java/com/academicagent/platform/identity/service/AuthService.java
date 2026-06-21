package com.academicagent.platform.identity.service;

import java.time.Instant;
import java.util.UUID;

import com.academicagent.platform.common.ApiException;
import com.academicagent.platform.identity.crypto.JwtService;
import com.academicagent.platform.identity.crypto.PasswordHasher;
import com.academicagent.platform.identity.entity.User;
import com.academicagent.platform.identity.mapper.UserMapper;
import com.academicagent.platform.identity.model.AuthResult;
import com.academicagent.platform.identity.model.UserProfile;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AuthService {

    private final UserMapper userMapper;
    private final PasswordHasher passwordHasher;
    private final JwtService jwtService;
    private final UserService userService;

    public AuthService(
            UserMapper userMapper,
            PasswordHasher passwordHasher,
            JwtService jwtService,
            UserService userService) {
        this.userMapper = userMapper;
        this.passwordHasher = passwordHasher;
        this.jwtService = jwtService;
        this.userService = userService;
    }

    @Transactional
    public AuthResult register(String email, String password, String displayName) {
        if (userMapper.existsByEmailIgnoreCase(email)) {
            throw new ApiException("Email already registered", HttpStatus.CONFLICT, "email_exists");
        }
        User user = new User();
        user.setUserId(UUID.randomUUID().toString());
        user.setEmail(email.toLowerCase());
        user.setDisplayName(displayName);
        user.setPasswordHash(passwordHasher.hash(password));
        user.setCreatedAt(Instant.now());
        userMapper.insert(user);
        return buildAuthResult(user);
    }

    @Transactional(readOnly = true)
    public AuthResult login(String email, String password) {
        User user = userMapper
                .findByEmailIgnoreCase(email)
                .orElseThrow(() -> new ApiException("Invalid credentials", HttpStatus.UNAUTHORIZED, "invalid_credentials"));
        if (!passwordHasher.matches(password, user.getPasswordHash())) {
            throw new ApiException("Invalid credentials", HttpStatus.UNAUTHORIZED, "invalid_credentials");
        }
        return buildAuthResult(user);
    }

    @Transactional(readOnly = true)
    public UserProfile getProfile(String userId) {
        return userService.getProfile(userId);
    }

    private AuthResult buildAuthResult(User user) {
        UserProfile profile = userService.toProfile(user);
        String token = jwtService.createToken(user.getUserId(), user.getEmail());
        return new AuthResult(token, "Bearer", jwtService.getExpirationSeconds(), profile);
    }
}
